import { describe, expect, it, vi } from "vitest"

import {
  AbstractAgentProvider,
  AbstractSandboxProvider,
  SandboxCommand,
  type AgentExecutionContext,
  type AgentProviderSession,
  type AgentProviderTurn,
  type AgentRequest,
  type AgentResponse,
  type ProvisionedSandbox,
  type SandboxAcquireRequest,
  type SandboxRuntime,
} from "../src/core.js"
import { validateSandboxRuntime } from "../src/components/sandbox/validate-sandbox-runtime.js"
import { createAgentExecutionContext } from "../src/testing/create-agent-execution-context.js"

const request: AgentRequest = Object.freeze({
  followUps: Object.freeze(["second", "final"]),
  mcpServers: Object.freeze([]),
  output: Object.freeze({
    jsonSchema: Object.freeze({ type: "object" }),
    type: "json",
  }),
  permissions: Object.freeze({ filesystem: "read-write", network: true, shell: true }),
  prompt: "first",
  skills: Object.freeze([]),
  system: "",
  tools: Object.freeze([]),
})

class RecordingAgentProvider extends AbstractAgentProvider<"recording"> {
  readonly events: string[] = []
  session: AgentProviderSession

  constructor(session?: AgentProviderSession) {
    super("recording")
    this.session =
      session ??
      ({
        close: async () => {
          this.events.push("close")
        },
        runTurn: async turn => {
          this.events.push(`turn:${turn.index}:${turn.prompt}:${turn.output === undefined ? "text" : "json"}`)
          return turn.output === undefined ? { text: turn.prompt } : { structured: { ok: true }, text: turn.prompt }
        },
      } satisfies AgentProviderSession)
  }

  protected async openSession(_request: AgentRequest, _context: AgentExecutionContext): Promise<AgentProviderSession> {
    this.events.push("open")
    return this.session
  }
}

describe("AbstractAgentProvider", () => {
  it("owns turn order, final output selection, and cleanup", async () => {
    const provider = new RecordingAgentProvider()

    await expect(provider.run(request, createAgentExecutionContext())).resolves.toEqual({
      structured: { ok: true },
      text: "final",
    })
    expect(provider.events).toEqual(["open", "turn:0:first:text", "turn:1:second:text", "turn:2:final:json", "close"])
  })

  it("requests one abort, stops later turns, and still closes", async () => {
    const controller = new AbortController()
    const cancelled = new Error("cancelled")
    const turns: AgentProviderTurn[] = []
    const abort = vi.fn(async () => {})
    const close = vi.fn(async () => {})
    const provider = new RecordingAgentProvider({
      abort,
      close,
      async runTurn(turn): Promise<AgentResponse> {
        turns.push(turn)
        controller.abort(cancelled)
        return { text: turn.prompt }
      },
    })

    await expect(provider.run(request, createAgentExecutionContext({ signal: controller.signal }))).rejects.toBe(
      cancelled
    )
    expect(turns).toHaveLength(1)
    expect(abort).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it("preserves the caller cancellation reason when a turn rejects during abort", async () => {
    const controller = new AbortController()
    const cancellation = new Error("caller cancellation")
    const providerError = new Error("provider aborted")
    const abort = vi.fn(async () => {})
    const close = vi.fn(async () => {})
    const provider = new RecordingAgentProvider({
      abort,
      close,
      async runTurn() {
        controller.abort(cancellation)
        throw providerError
      },
    })

    await expect(provider.run(request, createAgentExecutionContext({ signal: controller.signal }))).rejects.toBe(
      cancellation
    )
    expect(abort).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it("preserves cancellation, abort, and cleanup failures in lifecycle order", async () => {
    const controller = new AbortController()
    const cancellation = new Error("cancel")
    const abortError = new Error("abort")
    const cleanupError = new Error("cleanup")
    const provider = new RecordingAgentProvider({
      async abort() {
        throw abortError
      },
      async close() {
        throw cleanupError
      },
      async runTurn() {
        controller.abort(cancellation)
        throw new Error("provider aborted")
      },
    })

    const error = await provider
      .run(request, createAgentExecutionContext({ signal: controller.signal }))
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([cancellation, abortError, cleanupError])
  })

  it("fails closed for Sandbox compatibility", () => {
    const provider = new RecordingAgentProvider()

    expect(
      provider.supportsSandbox({
        access: "read-write",
        cwd: ".",
        lease: {
          handle: undefined,
          id: "lease",
          runtime: {
            access: "read-write",
            async createFileStaging() {
              return emptyFileStaging()
            },
            cwd: ".",
            async exec() {
              return { exitCode: 0, stderr: "", stdout: "" }
            },
            async readFile() {
              return new Uint8Array()
            },
            root: ".",
            spawn: async () => completedTestProcess(),
            async stat() {
              return { kind: "file", size: 0 } as const
            },
            async writeFile() {},
          },
        },
        nested: false,
        provider: { name: "sandbox" },
        root: ".",
      })
    ).toBe(false)
  })
})

interface TestSandboxResource {
  readonly id: string
}

class RecordingSandboxProvider extends AbstractSandboxProvider<
  "recording-sandbox",
  { readonly id: string },
  TestSandboxResource
> {
  readonly events: string[] = []
  initializeError: unknown
  releaseError: unknown

  constructor() {
    super("recording-sandbox")
  }

  protected async provision(): Promise<Readonly<ProvisionedSandbox<{ readonly id: string }, TestSandboxResource>>> {
    this.events.push("provision")
    const resource = { id: "resource" }
    return Object.freeze({
      handle: Object.freeze({ id: resource.id }),
      id: "lease",
      resource,
    })
  }

  protected createRuntime(
    _provisioned: Readonly<ProvisionedSandbox<{ readonly id: string }, TestSandboxResource>>,
    request: SandboxAcquireRequest
  ): Readonly<SandboxRuntime> {
    this.events.push("runtime")
    return Object.freeze({
      access: request.access,
      async createFileStaging() {
        return emptyFileStaging()
      },
      cwd: request.cwd,
      async exec() {
        return Object.freeze({ exitCode: 0, stderr: "", stdout: "" })
      },
      async readFile() {
        return new Uint8Array()
      },
      root: request.root,
      spawn: async () => completedTestProcess(),
      async stat() {
        return Object.freeze({ kind: "file" as const, size: 0 })
      },
      async writeFile() {},
    })
  }

  protected override async initialize(): Promise<void> {
    this.events.push("initialize")

    if (this.initializeError !== undefined) {
      throw this.initializeError
    }
  }

  protected async releaseResource(): Promise<void> {
    this.events.push("release")

    if (this.releaseError !== undefined) {
      throw this.releaseError
    }
  }
}

function emptyFileStaging() {
  return Object.freeze({
    async release() {},
    root: "/tmp/aml-test-staging",
    async writeFile() {},
  })
}

const sandboxRequest: SandboxAcquireRequest = Object.freeze({
  access: "read-write",
  cwd: "repository/src",
  evaluationId: "evaluation",
  root: "repository",
  signal: new AbortController().signal,
})

describe("AbstractSandboxProvider", () => {
  it("owns staged acquisition and one shared release barrier", async () => {
    const provider = new RecordingSandboxProvider()
    const lease = await provider.acquire(sandboxRequest)

    await Promise.all([lease.release(), lease.release()])

    expect(provider.events).toEqual(["provision", "runtime", "initialize", "release"])
    expect(lease.handle).toEqual({ id: "resource" })
  })

  it("compensates initialization failure and preserves cleanup failure", async () => {
    const provider = new RecordingSandboxProvider()
    const initializeError = new Error("initialize")
    const releaseError = new Error("release")
    provider.initializeError = initializeError
    provider.releaseError = releaseError

    const error = await provider.acquire(sandboxRequest).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([initializeError, releaseError])
    expect(provider.events).toEqual(["provision", "runtime", "initialize", "release"])
  })
})

describe("SandboxCommand", () => {
  it("captures portable command inputs", () => {
    const command = SandboxCommand.from(sandboxRequest, "node", ["script.js"], {
      cwd: "repository/src",
      env: { MODE: "test" },
      timeoutMs: 1_000,
    })

    expect(command).toMatchObject({
      args: ["script.js"],
      command: "node",
      cwd: "repository/src",
      env: { MODE: "test" },
      timeoutMs: 1_000,
    })
    expect(Object.isFrozen(command)).toBe(true)
    expect(Object.isFrozen(command.args)).toBe(true)
    expect(Object.isFrozen(command.env)).toBe(true)
  })

  it("rejects cwd escapes and invalid environment entries", () => {
    expect(() => SandboxCommand.from(sandboxRequest, "node", [], { cwd: "other" })).toThrow(
      "Sandbox command cwd resolves outside its configured root"
    )
    expect(() => SandboxCommand.from(sandboxRequest, "node", [], { env: { "BAD-KEY": "value" } })).toThrow(
      "Sandbox command environment contains an invalid entry"
    )
  })
})

describe("validated Sandbox runtime", () => {
  it("captures and freezes command results", async () => {
    const result = { exitCode: 0, stderr: "", stdout: "ok" }
    const runtime = validateSandboxRuntime(
      {
        access: "read-write",
        ...fixtureFileRuntime(),
        cwd: ".",
        async exec() {
          return result
        },
        root: ".",
        spawn: async () => completedTestProcess(),
      },
      "fixture"
    )
    const captured = await runtime.exec("true")

    result.stdout = "changed"
    expect(captured).toEqual({ exitCode: 0, stderr: "", stdout: "ok" })
    expect(Object.isFrozen(captured)).toBe(true)
  })

  it("rejects malformed command results", async () => {
    const runtime = validateSandboxRuntime(
      {
        access: "read-write",
        ...fixtureFileRuntime(),
        cwd: ".",
        async exec() {
          return { exitCode: "0", stderr: "", stdout: "" }
        },
        root: ".",
        spawn: async () => completedTestProcess(),
      },
      "fixture"
    )

    await expect(runtime.exec("true")).rejects.toThrow('Sandbox provider "fixture" returned an invalid command result')
  })

  it("captures standard process streams and makes kill and wait idempotent", async () => {
    let kills = 0
    let waits = 0
    let written: Uint8Array | undefined
    const exit = { exitCode: 0 }
    const process = {
      id: "process-1",
      async kill() {
        kills += 1
      },
      stdin: new WritableStream<Uint8Array>({
        write(data) {
          written = new Uint8Array(data)
        },
      }),
      stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
      stdout: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
      async wait() {
        waits += 1
        return exit
      },
    }
    const runtime = validateSandboxRuntime(
      {
        access: "read-write",
        ...fixtureFileRuntime(),
        cwd: ".",
        async exec() {
          return { exitCode: 0, stderr: "", stdout: "" }
        },
        root: ".",
        async spawn() {
          return process
        },
      },
      "fixture"
    )
    const captured = await runtime.spawn("server")
    const input = new Uint8Array([1, 2, 3])
    const writer = captured.stdin.getWriter()

    await writer.write(input)
    await writer.close()
    await Promise.all([captured.kill(), captured.kill()])
    const [firstExit, secondExit] = await Promise.all([captured.wait(), captured.wait()])
    input[0] = 9
    exit.exitCode = 7

    expect({ kills, waits }).toEqual({ kills: 1, waits: 1 })
    expect(firstExit).toBe(secondExit)
    expect(firstExit).toEqual({ exitCode: 0 })
    expect(Object.isFrozen(firstExit)).toBe(true)
    expect(written).toEqual(new Uint8Array([1, 2, 3]))
  })
})

function completedTestProcess() {
  return Object.freeze({
    id: "fixture-process",
    async kill() {},
    stdin: new WritableStream(),
    stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
    stdout: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
    async wait() {
      return Object.freeze({ exitCode: 0 })
    },
  })
}

function fixtureFileRuntime() {
  return {
    async createFileStaging() {
      return emptyFileStaging()
    },
    async readFile() {
      return new Uint8Array()
    },
    async stat() {
      return Object.freeze({ kind: "file" as const, size: 0 })
    },
    async writeFile() {},
  }
}
