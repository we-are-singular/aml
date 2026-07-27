import type { Writable } from "node:stream"

import { beforeEach, describe, expect, it, vi } from "vitest"

const dependencies = vi.hoisted(() => ({
  createOpencodeClient: vi.fn(),
  execa: vi.fn(),
}))

vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencodeClient: dependencies.createOpencodeClient,
}))
vi.mock("execa", () => ({ execa: dependencies.execa }))

import { createIsolatedOpencode } from "../src/create-isolated-opencode.js"

interface CapturedSpawnOptions {
  readonly cancelSignal: AbortSignal
  readonly env: Readonly<Record<string, string>>
  readonly extendEnv: boolean
  readonly forceKillAfterDelay: number
  readonly killDescendants: boolean
  readonly reject: boolean
  readonly stderr: Writable
  readonly stdin: string
  readonly stdout: Writable
}

interface FakeProcessResult {
  readonly cause?: unknown
  readonly exitCode?: number
  readonly failed: boolean
  readonly isCanceled: boolean
  readonly isTerminated: boolean
  readonly signal?: string
}

/**
 * Provides a controllable Execa result without starting a real OpenCode host.
 */
function installFakeProcess(): {
  readonly captured: () => CapturedSpawnOptions
  readonly resolve: (result: FakeProcessResult) => void
} {
  let captured: CapturedSpawnOptions | undefined
  let resolveProcess:
    | ((result: FakeProcessResult) => void)
    | undefined
  const process = new Promise<FakeProcessResult>((resolve) => {
    resolveProcess = resolve
  })

  dependencies.execa.mockImplementation(
    (
      _command: string,
      _args: readonly string[],
      options: CapturedSpawnOptions,
    ) => {
      captured = options
      options.cancelSignal.addEventListener(
        "abort",
        () => {
          resolveProcess?.({
            failed: true,
            isCanceled: true,
            isTerminated: true,
            signal: "SIGTERM",
          })
        },
        { once: true },
      )
      return process
    },
  )

  return {
    captured() {
      if (captured === undefined) {
        throw new Error("Expected OpenCode process to be spawned")
      }

      return captured
    },
    resolve(result) {
      resolveProcess?.(result)
    },
  }
}

describe("createIsolatedOpencode", () => {
  beforeEach(() => {
    dependencies.createOpencodeClient.mockReset()
    dependencies.execa.mockReset()
    dependencies.createOpencodeClient.mockReturnValue({
      kind: "generated-client",
    })
  })

  it("passes an isolated child environment and owns process shutdown", async () => {
    const callerDatabase = process.env.OPENCODE_DB
    process.env.OPENCODE_DB = "/caller/opencode.db"
    const fake = installFakeProcess()

    try {
      const starting = createIsolatedOpencode({
        config: { logLevel: "DEBUG" },
        hostname: "127.0.0.2",
        port: 0,
        timeout: 10_000,
      })
      const spawn = fake.captured()
      spawn.stdout.write(
        "booting\nopencode server listening on http://127.0.0.2:43210\n",
      )
      const owned = await starting

      expect(dependencies.execa).toHaveBeenCalledWith(
        "opencode",
        [
          "serve",
          "--hostname=127.0.0.2",
          "--port=0",
          "--log-level=DEBUG",
        ],
        expect.objectContaining({
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              logLevel: "DEBUG",
            }),
            OPENCODE_DB: ":memory:",
          },
          extendEnv: true,
          forceKillAfterDelay: 5_000,
          killDescendants: true,
          reject: false,
          stdin: "ignore",
        }),
      )
      expect(process.env.OPENCODE_DB).toBe(
        "/caller/opencode.db",
      )
      expect(
        dependencies.createOpencodeClient,
      ).toHaveBeenCalledWith({
        baseUrl: "http://127.0.0.2:43210",
      })
      expect(owned.client).toEqual({ kind: "generated-client" })
      expect(owned.server.url).toBe("http://127.0.0.2:43210")

      const firstClose = owned.server.close()
      const secondClose = owned.server.close()

      expect(secondClose).toBe(firstClose)
      await expect(firstClose).resolves.toBeUndefined()
      expect(spawn.cancelSignal.aborted).toBe(true)
    } finally {
      if (callerDatabase === undefined) {
        delete process.env.OPENCODE_DB
      } else {
        process.env.OPENCODE_DB = callerDatabase
      }
    }
  })

  it("preserves bounded startup diagnostics from an early exit", async () => {
    const fake = installFakeProcess()
    const starting = createIsolatedOpencode({ timeout: 10_000 })
    const spawn = fake.captured()

    spawn.stderr.write("configuration failed")
    fake.resolve({
      exitCode: 1,
      failed: true,
      isCanceled: false,
      isTerminated: false,
    })

    await expect(starting).rejects.toThrow(
      "OpenCode server exited with code 1\nServer output: configuration failed",
    )
  })

  it("waits for a complete readiness line before publishing its URL", async () => {
    const fake = installFakeProcess()
    const starting = createIsolatedOpencode({ timeout: 10_000 })
    const spawn = fake.captured()
    let settled = false

    void starting.then(() => {
      settled = true
    })
    spawn.stdout.write(
      "opencode server listening on http://127.0.0.1:43",
    )
    await Promise.resolve()

    expect(settled).toBe(false)

    spawn.stdout.write("210\n")
    const owned = await starting

    expect(owned.server.url).toBe("http://127.0.0.1:43210")
    await owned.server.close()
  })

  it("preserves bounded diagnostics when a ready server later fails", async () => {
    const fake = installFakeProcess()
    const starting = createIsolatedOpencode({ timeout: 10_000 })
    const spawn = fake.captured()

    spawn.stdout.write(
      "opencode server listening on http://127.0.0.1:43210\n",
    )
    const owned = await starting
    spawn.stderr.write("database became unavailable")
    fake.resolve({
      exitCode: 2,
      failed: true,
      isCanceled: false,
      isTerminated: false,
    })

    await expect(owned.server.close()).rejects.toThrow(
      "OpenCode server exited with code 2\nServer output: opencode server listening on http://127.0.0.1:43210\ndatabase became unavailable",
    )
  })

  it("terminates and drains a host that misses its startup deadline", async () => {
    vi.useFakeTimers()
    const fake = installFakeProcess()

    try {
      const starting = createIsolatedOpencode({ timeout: 25 })
      const spawn = fake.captured()
      const failure = starting.catch((error: unknown) => error)

      await vi.advanceTimersByTimeAsync(25)

      await expect(failure).resolves.toEqual(
        expect.objectContaining({
          message:
            "Timeout waiting for OpenCode server to start after 25ms",
        }),
      )
      expect(spawn.cancelSignal.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
