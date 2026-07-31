import { spawn } from "node:child_process"
import type { Readable } from "node:stream"

import type { SandboxProcess, SandboxProcessExit } from "../sandbox/sandbox-runtime.js"

export interface LocalProcessOptions {
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

  return new LocalProcess(child, options)
}

class LocalProcess implements SandboxProcess {
  readonly #child: ReturnType<typeof spawn>
  readonly #completion: Promise<Readonly<SandboxProcessExit>>
  readonly #signal: AbortSignal
  readonly #timeout: ReturnType<typeof setTimeout> | undefined
  #closePromise: Promise<void> | undefined
  #finished = false
  #killPromise: Promise<void> | undefined
  readonly id: string
  readonly pid: number
  readonly stderr: ReadableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>

  constructor(child: ReturnType<typeof spawn>, options: Readonly<LocalProcessOptions>) {
    if (child.pid === undefined || child.stdout === null || child.stderr === null || child.stdin === null) {
      child.kill()
      throw new Error("Local process transport failed to create process pipes")
    }

    this.#child = child
    this.#signal = options.signal
    this.id = `local-process:${child.pid}`
    this.pid = child.pid
    this.stdout = nodeReadableStream(child.stdout)
    this.stderr = nodeReadableStream(child.stderr)
    this.#completion = new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => {
        this.#finished = true
        this.#removeAbortListener()
        if (this.#timeout !== undefined) clearTimeout(this.#timeout)

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

  async closeInput(): Promise<void> {
    if (this.#finished) return

    this.#closePromise ??= new Promise<void>(resolve => {
      this.#child.stdin?.end(resolve)
    })
    await this.#closePromise
  }

  async kill(): Promise<void> {
    if (this.#finished) return

    this.#killPromise ??= Promise.resolve().then(() => {
      try {
        if (process.platform === "win32") {
          this.#child.kill("SIGKILL")
        } else {
          process.kill(-this.pid, "SIGKILL")
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    })
    await this.#killPromise
  }

  async wait(): Promise<Readonly<SandboxProcessExit>> {
    return await this.#completion
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.#finished || this.#child.stdin === null || this.#child.stdin.destroyed) {
      throw new Error("Local process input is closed")
    }

    await new Promise<void>((resolve, reject) => {
      this.#child.stdin?.write(data, (error: Error | null | undefined) =>
        error === null || error === undefined ? resolve() : reject(error)
      )
    })
  }

  readonly #onAbort = (): void => {
    void this.kill()
  }

  #removeAbortListener(): void {
    this.#signal.removeEventListener("abort", this.#onAbort)
  }
}

function nodeReadableStream(stream: Readable): ReadableStream<Uint8Array> {
  let controller: ReadableStreamDefaultController<Uint8Array>
  const readable = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
    cancel() {
      stream.destroy()
    },
    pull() {
      stream.resume()
    },
  })

  // Attach before returning the process handle so early output is queued even
  // when the consumer starts reading after process exit.
  stream.on("data", chunk => {
    controller.enqueue(new Uint8Array(Buffer.from(chunk)))
    if ((controller.desiredSize ?? 0) <= 0) stream.pause()
  })
  stream.once("end", () => controller.close())
  stream.once("error", error => controller.error(error))
  return readable
}
