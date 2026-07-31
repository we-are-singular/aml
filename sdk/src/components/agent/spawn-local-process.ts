import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"

import type { SandboxProcess, SandboxProcessExit } from "../sandbox/sandbox-runtime.js"

export interface LocalProcessOptions {
  readonly beforeKill?: () => Promise<void>
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly signal: AbortSignal
  readonly timeoutMs?: number
}

/**
 * Starts one trusted host command with queued output and process-tree cleanup.
 *
 * This is the local process transport used by the ACP engine and Local
 * Sandbox. It does not provide filesystem, access, or network isolation.
 */
export async function spawnLocalProcess(
  command: string,
  args: readonly string[],
  options: Readonly<LocalProcessOptions>
): Promise<Readonly<SandboxProcess>> {
  options.signal.throwIfAborted()
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: { ...process.env, ...options.env, PWD: options.cwd },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })

  const started = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })
  const localProcess = new LocalProcess(child, options)
  await started
  return localProcess
}

class LocalProcess implements SandboxProcess {
  readonly #beforeKill: (() => Promise<void>) | undefined
  readonly #child: ReturnType<typeof spawn>
  readonly #completion: Promise<Readonly<SandboxProcessExit>>
  readonly #signal: AbortSignal
  readonly #timeout: ReturnType<typeof setTimeout> | undefined
  #finished = false
  #killPromise: Promise<void> | undefined
  readonly stdin: WritableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>

  constructor(child: ReturnType<typeof spawn>, options: Readonly<LocalProcessOptions>) {
    if (child.stdout === null || child.stderr === null || child.stdin === null) {
      child.kill()
      throw new Error("Local process transport failed to create process pipes")
    }

    this.#child = child
    this.#beforeKill = options.beforeKill
    this.#signal = options.signal
    this.stdin = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
    this.stdout = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    this.stderr = Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>
    this.#completion = new Promise((resolve, reject) => {
      child.once("error", error => {
        this.#finish()
        reject(error)
      })
      child.once("close", (code, signal) => {
        this.#finish()

        if (options.signal.aborted) {
          reject(options.signal.reason)
          return
        }

        if (code === null) {
          reject(new Error(`Local process exited from signal ${signal ?? "unknown"}`))
          return
        }

        resolve(Object.freeze({ exitCode: code }))
      })
    })
    void this.#completion.catch(() => undefined)

    options.signal.addEventListener("abort", this.#onAbort, { once: true })
    if (options.signal.aborted) this.#onAbort()
    if (options.timeoutMs !== undefined) {
      const timeout = setTimeout(() => void this.kill(), options.timeoutMs)
      timeout.unref()
      this.#timeout = timeout
      if (this.#finished) clearTimeout(timeout)
    }
  }

  get id(): string {
    return `local-process:${this.#child.pid ?? "pending"}`
  }

  async kill(): Promise<void> {
    if (this.#finished) return

    this.#killPromise ??= Promise.resolve().then(async () => {
      const errors: unknown[] = []

      try {
        await this.#beforeKill?.()
      } catch (error) {
        errors.push(error)
      }

      try {
        if (process.platform === "win32") {
          this.#child.kill("SIGKILL")
        } else if (this.#child.pid === undefined) {
          this.#child.kill("SIGKILL")
        } else {
          process.kill(-this.#child.pid, "SIGKILL")
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") errors.push(error)
      }

      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, "Process cleanup failed")
    })
    await this.#killPromise
  }

  async wait(): Promise<Readonly<SandboxProcessExit>> {
    return await this.#completion
  }

  readonly #onAbort = (): void => {
    void this.kill()
  }

  #finish(): void {
    this.#finished = true
    this.#removeAbortListener()
    if (this.#timeout !== undefined) clearTimeout(this.#timeout)
  }

  #removeAbortListener(): void {
    this.#signal.removeEventListener("abort", this.#onAbort)
  }
}
