import { Writable } from "node:stream"

import { createOpencodeClient, type OpencodeClient, type ServerOptions } from "@opencode-ai/sdk/v2"
import { defu } from "defu"
import { execa } from "execa"

const DEFAULT_HOSTNAME = "127.0.0.1"
const DEFAULT_PORT = 4096
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024
const SERVER_READY_PREFIX = "opencode server listening"

interface OwnedOpenCodeHost {
  readonly client: OpencodeClient
  readonly server: {
    readonly url: string
    close(): Promise<void>
  }
}

interface OpenCodeProcessResult {
  readonly cause?: unknown
  readonly exitCode?: number
  readonly failed: boolean
  readonly isCanceled: boolean
  readonly signal?: string
}

/**
 * Starts one package-owned OpenCode host with process-private session state.
 *
 * The upstream SDK does not expose a child-process environment option. Execa
 * owns that missing transport seam so AML can pass `OPENCODE_DB=:memory:`
 * directly to each child without mutating process-wide state.
 */
export async function createIsolatedOpencode(options: ServerOptions): Promise<OwnedOpenCodeHost> {
  const resolved = defu(options, {
    hostname: DEFAULT_HOSTNAME,
    port: DEFAULT_PORT,
    timeout: DEFAULT_STARTUP_TIMEOUT_MS,
  })
  const hostname = resolved.hostname
  const port = resolved.port
  const startupTimeout = resolved.timeout
  const lifecycle = new AbortController()
  const cancelSignal =
    resolved.signal === undefined ? lifecycle.signal : AbortSignal.any([lifecycle.signal, resolved.signal])
  const args = ["serve", `--hostname=${hostname}`, `--port=${port}`]

  if (resolved.config?.logLevel !== undefined) {
    args.push(`--log-level=${resolved.config.logLevel}`)
  }

  let processOutput = ""
  let pendingStdout = ""
  let ready = false
  let resolveReady: ((url: string) => void) | undefined
  let rejectReady: ((error: unknown) => void) | undefined
  const readiness = new Promise<string>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  /**
   * Keeps enough lifecycle diagnostics to explain failures without allowing
   * a noisy or compromised child to grow the parent process without bound.
   */
  const captureProcessOutput = (chunk: string): void => {
    processOutput = `${processOutput}${chunk}`.slice(-MAX_PROCESS_OUTPUT_BYTES)
  }

  /**
   * Parses complete stdout lines while still draining output after readiness.
   */
  const stdout = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        const text = chunk.toString()
        captureProcessOutput(text)

        if (!ready) {
          pendingStdout = `${pendingStdout}${text}`.slice(-MAX_PROCESS_OUTPUT_BYTES)
          const lines = pendingStdout.split(/\r?\n/)
          pendingStdout = lines.pop() ?? ""

          for (const line of lines) {
            const url = parseServerUrl(line)

            if (url !== undefined) {
              ready = true
              resolveReady?.(url)
              break
            }
          }
        }
      } catch (error) {
        rejectReady?.(error)
        lifecycle.abort(
          error instanceof Error
            ? error
            : new Error("OpenCode readiness parsing failed", {
                cause: error,
              })
        )
      }

      callback()
    },
  })
  const stderr = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      captureProcessOutput(chunk.toString())
      callback()
    },
  })

  // Writable sinks prevent Execa from retaining an unbounded server log while
  // still continuously draining both child streams for the host lifetime.
  const child = execa("opencode", args, {
    cancelSignal,
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(resolved.config ?? {}),
      OPENCODE_DB: ":memory:",
    },
    extendEnv: true,
    forceKillAfterDelay: 5_000,
    killDescendants: true,
    reject: false,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  })
  child.stdout.pipe(stdout)
  child.stderr.pipe(stderr)

  const completion = child.then(result => {
    if (!ready) {
      rejectReady?.(cancelSignal.aborted ? cancelSignal.reason : serverExitError(result, processOutput))
    }

    return result
  })
  const timeoutError = new Error(`Timeout waiting for OpenCode server to start after ${startupTimeout}ms`)
  const timeout = setTimeout(() => {
    if (ready) {
      return
    }

    rejectReady?.(timeoutError)
    lifecycle.abort(timeoutError)
  }, startupTimeout)

  let url: string

  try {
    url = await readiness
  } catch (startupError) {
    // A parse failure, early exit, caller cancellation, or timeout all own the
    // same child. Terminate it and wait for Execa's force-kill barrier before
    // returning control so a failed startup cannot leak a background host.
    lifecycle.abort(
      startupError instanceof Error
        ? startupError
        : new Error("OpenCode server startup failed", {
            cause: startupError,
          })
    )
    await completion
    throw startupError
  } finally {
    clearTimeout(timeout)
  }

  let closePromise: Promise<void> | undefined

  return Object.freeze({
    client: createOpencodeClient({ baseUrl: url }),
    server: Object.freeze({
      url,

      /**
       * Terminates this package-owned host once and waits for process exit.
       */
      close(): Promise<void> {
        closePromise ??= (async () => {
          lifecycle.abort(new Error("OpenCode server closed by AML"))
          const result = await completion

          // Cancellation initiated by this close path is expected. A process
          // that died independently remains an owned-resource failure.
          if (result.failed && !result.isCanceled) {
            throw serverExitError(result, processOutput)
          }
        })()

        return closePromise
      },
    }),
  })
}

/**
 * Extracts the URL from the stable readiness line emitted by `opencode serve`.
 */
function parseServerUrl(line: string): string | undefined {
  if (!line.startsWith(SERVER_READY_PREFIX)) {
    return undefined
  }

  const match = line.match(/on\s+(https?:\/\/[^\s]+)/)

  if (match?.[1] === undefined) {
    throw new Error(`Failed to parse OpenCode server URL from output: ${line}`)
  }

  return match[1]
}

/**
 * Preserves bounded child diagnostics when the server exits before readiness.
 */
function serverExitError(result: OpenCodeProcessResult, output: string): Error {
  const status = result.exitCode === undefined ? (result.signal ?? "without an exit code") : `code ${result.exitCode}`
  const diagnostics = output.trim().length === 0 ? "" : `\nServer output: ${output.trim()}`

  return new Error(
    `OpenCode server exited with ${status}${diagnostics}`,
    result.cause === undefined ? undefined : { cause: result.cause }
  )
}
