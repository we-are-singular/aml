import type {
  AgentExecutionContext,
  AgentRequest,
  AgentResponse,
} from "@aml/sdk"
import {
  Agent,
  AmlRuntime,
  defineMcpServer,
  defineTool,
  evaluate,
  Mcp,
  Tool,
} from "@aml/sdk"
import { agentProviderConformance } from "@aml/sdk/testing"
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { z } from "zod"
import { beforeEach, describe, expect, it, vi } from "vitest"

const openCodeSdk = vi.hoisted(() => ({
  createOpencode: vi.fn(),
}))

vi.mock("@opencode-ai/sdk/v2", () => openCodeSdk)

import {
  opencodeAgent,
  type OpenCodeSessionClient,
  type OpenCodeSessionCreateInput,
  type OpenCodeSessionLocation,
  type OpenCodeSessionPromptInput,
  type OpenCodeSessionPromptResult,
  type OpenCodeCapabilityAttachmentInput,
} from "../src/index.js"
import { OpenCodeCapabilityAttachment } from "../src/opencode-capability-attachment.js"
import { OpenCodeSdkClient } from "../src/opencode-sdk-client.js"
import { OpenCodeSession } from "../src/opencode-session.js"

class RecordingSessionClient implements OpenCodeSessionClient {
  readonly abortCalls: OpenCodeSessionLocation[] = []
  readonly createCalls: {
    input: OpenCodeSessionCreateInput
    signal: AbortSignal
  }[] = []
  readonly deleteCalls: OpenCodeSessionLocation[] = []
  readonly events: string[] = []
  readonly promptCalls: {
    input: OpenCodeSessionPromptInput
    signal: AbortSignal
  }[] = []
  readonly capabilityAttachmentCalls: {
    input: OpenCodeCapabilityAttachmentInput
    signal: AbortSignal
  }[] = []
  readonly capabilityAttachmentClose = vi.fn(async () => undefined)
  promptResult: OpenCodeSessionPromptResult = {
    parts: [{ text: "response", type: "text" }],
  }

  async create(
    input: OpenCodeSessionCreateInput,
    signal: AbortSignal,
  ): Promise<string> {
    this.events.push("create")
    this.createCalls.push({ input, signal })
    return `session-${this.createCalls.length}`
  }

  async prompt(
    input: OpenCodeSessionPromptInput,
    signal: AbortSignal,
  ): Promise<OpenCodeSessionPromptResult> {
    this.promptCalls.push({ input, signal })
    return this.promptResult
  }

  async attachCapabilities(
    input: OpenCodeCapabilityAttachmentInput,
    signal: AbortSignal,
  ): Promise<OpenCodeCapabilityAttachment> {
    this.events.push("attach")
    this.capabilityAttachmentCalls.push({ input, signal })

    if (
      input.structuredOutput &&
      input.tools.some(
        (tool) =>
          tool.kind === "host" &&
          (process.platform === "win32"
            ? tool.name.toLowerCase() === "structuredoutput"
            : tool.name === "StructuredOutput"),
      )
    ) {
      throw new TypeError(
        'OpenCode host Tool "StructuredOutput" is reserved by structured requests',
      )
    }

    return new OpenCodeCapabilityAttachment(
      input.structuredOutput
        ? { "*": false, StructuredOutput: true }
        : { "*": false },
      this.capabilityAttachmentClose,
    )
  }

  async abort(input: OpenCodeSessionLocation): Promise<void> {
    this.abortCalls.push(input)
  }

  async delete(input: OpenCodeSessionLocation): Promise<void> {
    this.deleteCalls.push(input)
  }
}

function createRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return Object.freeze({
    mcpServers: Object.freeze([]),
    prompt: "prompt",
    system: "system",
    tools: Object.freeze([]),
    ...overrides,
  })
}

function createContext(signal = new AbortController().signal) {
  const trace = Object.freeze({ runId: "run", spanId: "span-1" })
  return Object.freeze({ signal, trace }) satisfies AgentExecutionContext
}

/**
 * Supplies the reviewed OpenCode server contract to narrow SDK-client fakes.
 */
function createSdkClient(
  client: Record<string, unknown>,
  version = "1.18.5",
): OpenCodeSdkClient {
  return new OpenCodeSdkClient({
    global: {
      health: vi.fn(async () => ({
        data: { healthy: true, version },
      })),
    },
    ...client,
  } as never)
}

describe("opencodeAgent", () => {
  beforeEach(() => {
    openCodeSdk.createOpencode.mockReset()
  })

  it("is side-effect-free, immutable, and SDK-conformant", async () => {
    const client = new RecordingSessionClient()
    const provider = opencodeAgent({ sessionClient: client })

    expect(openCodeSdk.createOpencode).not.toHaveBeenCalled()
    expect(Object.isFrozen(provider)).toBe(true)
    expect(provider.name).toBe("opencode")

    await expect(agentProviderConformance(provider)).resolves.toBeUndefined()
    expect(client.createCalls).toHaveLength(1)
    expect(client.promptCalls[0]?.input.tools).toEqual({ "*": false })
    expect(client.deleteCalls).toEqual([{ sessionId: "session-1" }])

    await provider.close()
  })

  it("creates fresh sessions and applies model precedence", async () => {
    const client = new RecordingSessionClient()
    client.promptResult = {
      parts: [
        { text: "visible ", type: "text" },
        { synthetic: true, text: "synthetic", type: "text" },
        { ignored: true, text: "ignored", type: "text" },
        { text: "reasoning", type: "reasoning" },
        { text: "answer", type: "text" },
      ],
    }
    const provider = opencodeAgent({
      directory: "/workspace",
      model: "opencode-go/minimax-m3",
      sessionClient: client,
    })
    const runtime = new AmlRuntime({
      agentProvider: provider,
      system: "runtime system",
    })

    await expect(
      runtime.evaluate([
        <Agent>first</Agent>,
        <Agent model="anthropic/claude-sonnet-4-6">second</Agent>,
      ]),
    ).resolves.toBe("visible answervisible answer")

    expect(client.createCalls).toHaveLength(2)
    expect(client.createCalls.map(({ input }) => input)).toEqual([
      {
        directory: "/workspace",
        model: { modelId: "minimax-m3", providerId: "opencode-go" },
        title: "AML span-1",
      },
      {
        directory: "/workspace",
        model: {
          modelId: "claude-sonnet-4-6",
          providerId: "anthropic",
        },
        title: "AML span-2",
      },
    ])
    expect(client.promptCalls.map(({ input }) => input)).toEqual([
      {
        directory: "/workspace",
        model: { modelId: "minimax-m3", providerId: "opencode-go" },
        prompt: "first",
        sessionId: "session-1",
        system: "runtime system",
        tools: { "*": false },
      },
      {
        directory: "/workspace",
        model: {
          modelId: "claude-sonnet-4-6",
          providerId: "anthropic",
        },
        prompt: "second",
        sessionId: "session-2",
        system: "runtime system",
        tools: { "*": false },
      },
    ])
    expect(client.deleteCalls).toEqual([
      { directory: "/workspace", sessionId: "session-1" },
      { directory: "/workspace", sessionId: "session-2" },
    ])

    await provider.close()
  })

  it("returns provider-native structured output through component-local evaluate()", async () => {
    const client = new RecordingSessionClient()
    client.promptResult = {
      parts: [],
      structured: { count: 3 },
    }
    const provider = opencodeAgent({ sessionClient: client })
    const Result = z.object({ count: z.number() })

    async function Workflow() {
      const result = await evaluate(
        <Agent provider={provider}>Count findings.</Agent>,
        Result,
      )
      return `count:${result.count}`
    }

    await expect(new AmlRuntime().evaluate(<Workflow />)).resolves.toBe(
      "count:3",
    )
    expect(client.promptCalls[0]?.input.output).toMatchObject({
      jsonSchema: {
        properties: { count: { type: "number" } },
        type: "object",
      },
      type: "json",
    })
    expect(client.promptCalls[0]?.input.tools).toEqual({
      "*": false,
      StructuredOutput: true,
    })
    await provider.close()
  })

  it("reserves OpenCode's internal structured-output Tool name", async () => {
    const client = new RecordingSessionClient()
    const provider = opencodeAgent({ sessionClient: client })
    const Result = z.object({ count: z.number() })

    async function Workflow() {
      await evaluate(
        <Agent provider={provider}>
          <Tool name="StructuredOutput" />
          Count findings.
        </Agent>,
        Result,
      )
      return "unreachable"
    }

    const error = await new AmlRuntime()
      .evaluate(<Workflow />)
      .catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      cause: {
        message:
          'OpenCode host Tool "StructuredOutput" is reserved by structured requests',
      },
      message: 'Agent "opencode" (span-1) failed',
    })
    expect(client.capabilityAttachmentCalls).toHaveLength(1)
    expect(
      client.capabilityAttachmentCalls[0]?.input.structuredOutput,
    ).toBe(true)
    expect(client.createCalls).toHaveLength(0)
    await provider.close()
  })

  it("keeps MCP grants scoped to their containing Agent session", async () => {
    const client = new RecordingSessionClient()
    const provider = opencodeAgent({ sessionClient: client })
    const configured = defineMcpServer({
      name: "project",
      transport: {
        type: "streamable-http",
        url: "https://example.com/mcp",
      },
    })

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate([
        <Agent>
          <Mcp name="github" />
          <Mcp use={configured} />
          first
        </Agent>,
        <Agent>second</Agent>,
      ]),
    ).resolves.toBe("responseresponse")

    expect(
      client.capabilityAttachmentCalls.map(({ input }) =>
        input.mcpServers,
      ),
    ).toEqual([
      [
        { kind: "named", name: "github" },
        { definition: configured, kind: "configured" },
      ],
      [],
    ])
    expect(client.capabilityAttachmentClose).toHaveBeenCalledTimes(2)
    await provider.close()
  })

  it("rejects invalid configuration synchronously", () => {
    expect(() => opencodeAgent({ directory: "" })).toThrow(
      "OpenCode directory must be a non-empty string",
    )
    expect(() => opencodeAgent({ model: "missing-provider" })).toThrow(
      "OpenCode model must use provider/model",
    )
    expect(() => opencodeAgent({ model: " provider/model" })).toThrow(
      "OpenCode model must already be normalized",
    )
    expect(() =>
      opencodeAgent({
        server: {},
        sessionClient: new RecordingSessionClient(),
      }),
    ).toThrow("server and sessionClient options are mutually exclusive")
    expect(() => opencodeAgent({ server: { port: 65_536 } })).toThrow(
      "OpenCode server port must be an integer between 0 and 65535",
    )
    expect(() =>
      opencodeAgent({
        sessionClient: { create() {} } as never,
      }),
    ).toThrow("OpenCode sessionClient abort must be a function")
    expect(() =>
      opencodeAgent({
        sessionClient: {
          abort() {},
          create() {},
          delete() {},
          prompt() {},
        } as never,
      }),
    ).toThrow("OpenCode sessionClient attachCapabilities must be a function")
  })

  it("starts an owned server lazily and closes it once", async () => {
    const close = vi.fn()
    const rawClient = {
      session: {
        abort: vi.fn(async () => ({ data: true })),
        create: vi.fn(async () => ({
          data: { id: "owned-session" },
        })),
        delete: vi.fn(async () => ({ data: true })),
        prompt: vi.fn(async () => ({
          data: {
            info: {},
            parts: [{ text: "owned response", type: "text" }],
          },
        })),
      },
    }
    openCodeSdk.createOpencode.mockResolvedValue({
      client: rawClient,
      server: { close },
    })
    const provider = opencodeAgent({
      model: "opencode-go/minimax-m3",
      server: { hostname: "127.0.0.1", port: 0, timeout: 10_000 },
    })

    expect(openCodeSdk.createOpencode).not.toHaveBeenCalled()

    await expect(
      provider.run(createRequest(), createContext()),
    ).resolves.toEqual({ text: "owned response" })
    expect(openCodeSdk.createOpencode).toHaveBeenCalledWith({
      hostname: "127.0.0.1",
      port: 0,
      timeout: 10_000,
    })
    await provider.close()
    await provider.close()
    expect(close).toHaveBeenCalledTimes(1)
    await expect(
      provider.run(createRequest(), createContext()),
    ).rejects.toThrow("OpenCode Agent provider is closed")
  })

  it("uses disposable owned servers for dynamic capability sessions", async () => {
    const serverCloses: ReturnType<typeof vi.fn>[] = []
    let sessionIndex = 0

    openCodeSdk.createOpencode.mockImplementation(async () => {
      const close = vi.fn()
      const statuses: Record<string, { status: string }> = {}
      serverCloses.push(close)

      return {
        client: {
          global: {
            health: vi.fn(async () => ({
              data: { healthy: true, version: "1.18.5" },
            })),
          },
          mcp: {
            add: vi.fn(async ({ name }: { name: string }) => ({
              data: {
                ...statuses,
                [name]: (statuses[name] = { status: "connected" }),
              },
            })),
            disconnect: vi.fn(async ({ name }: { name: string }) => {
              statuses[name] = { status: "disabled" }
              return { data: true }
            }),
            status: vi.fn(async () => ({ data: { ...statuses } })),
          },
          session: {
            abort: vi.fn(async () => ({ data: true })),
            create: vi.fn(async () => ({
              data: { id: `tool-session-${++sessionIndex}` },
            })),
            delete: vi.fn(async () => ({ data: true })),
            prompt: vi.fn(async () => ({
              data: {
                info: {},
                parts: [{ text: "tool response", type: "text" }],
              },
            })),
          },
          tool: {
            ids: vi.fn(async () => ({ data: [] })),
          },
        },
        server: { close },
      }
    })
    const projectMcp = defineMcpServer({
      name: "project",
      transport: {
        type: "streamable-http",
        url: "https://example.com/mcp",
      },
    })
    const lookup = defineTool({
      description: "Look up one record",
      input: z.object({ id: z.number() }),
      name: "lookup",
      execute: async ({ id }) => ({ id }),
    })
    const provider = opencodeAgent()

    await expect(
      provider.run(createRequest(), createContext()),
    ).resolves.toEqual({ text: "tool response" })
    await expect(
      Promise.all([
        provider.run(
          createRequest({ tools: [lookup] }),
          createContext(),
        ),
        provider.run(
          createRequest({ tools: [lookup] }),
          createContext(),
        ),
      ]),
    ).resolves.toEqual([
      { text: "tool response" },
      { text: "tool response" },
    ])
    await expect(
      provider.run(
        createRequest({
          mcpServers: [
            { definition: projectMcp, kind: "configured" },
          ],
        }),
        createContext(),
      ),
    ).resolves.toEqual({ text: "tool response" })

    expect(openCodeSdk.createOpencode.mock.calls).toEqual([
      [{}],
      [{ port: 0 }],
      [{ port: 0 }],
      [{ port: 0 }],
    ])
    expect(serverCloses).toHaveLength(4)
    expect(serverCloses.map((close) => close.mock.calls.length)).toEqual([
      0,
      1,
      1,
      1,
    ])

    await provider.close()
    expect(serverCloses.map((close) => close.mock.calls.length)).toEqual([
      1,
      1,
      1,
      1,
    ])
  })

  it("shares one close barrier across concurrent callers", async () => {
    let finishPrompt: (() => void) | undefined
    let notifyPromptStarted: (() => void) | undefined
    const close = vi.fn()
    const promptStarted = new Promise<void>((resolve) => {
      notifyPromptStarted = resolve
    })
    const rawClient = {
      session: {
        abort: vi.fn(async () => ({ data: true })),
        create: vi.fn(async () => ({ data: { id: "active-session" } })),
        delete: vi.fn(async () => ({ data: true })),
        prompt: vi.fn(
          async () =>
            await new Promise<{
              data: {
                info: object
                parts: { text: string; type: string }[]
              }
            }>((resolve) => {
              finishPrompt = () =>
                resolve({
                  data: {
                    info: {},
                    parts: [{ text: "done", type: "text" }],
                  },
                })
              notifyPromptStarted?.()
            }),
        ),
      },
    }
    openCodeSdk.createOpencode.mockResolvedValue({
      client: rawClient,
      server: { close },
    })
    const provider = opencodeAgent()
    const run = provider.run(createRequest(), createContext())

    await promptStarted

    const firstClose = provider.close()
    const secondClose = provider.close()
    let closeSettled = false
    void secondClose.finally(() => {
      closeSettled = true
    })

    expect(secondClose).toBe(firstClose)
    await Promise.resolve()
    expect(closeSettled).toBe(false)
    expect(close).not.toHaveBeenCalled()

    finishPrompt?.()

    await expect(run).resolves.toEqual({ text: "done" })
    await expect(firstClose).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("preserves one owned-server close failure for every caller", async () => {
    const closeError = new Error("server close failed")
    const close = vi.fn(() => {
      throw closeError
    })
    const rawClient = {
      session: {
        abort: vi.fn(async () => ({ data: true })),
        create: vi.fn(async () => ({ data: { id: "owned-session" } })),
        delete: vi.fn(async () => ({ data: true })),
        prompt: vi.fn(async () => ({
          data: {
            info: {},
            parts: [{ text: "done", type: "text" }],
          },
        })),
      },
    }
    openCodeSdk.createOpencode.mockResolvedValue({
      client: rawClient,
      server: { close },
    })
    const provider = opencodeAgent()

    await provider.run(createRequest(), createContext())

    const firstClose = provider.close()
    const secondClose = provider.close()

    expect(secondClose).toBe(firstClose)
    await expect(firstClose).rejects.toBe(closeError)
    expect(provider.close()).toBe(firstClose)
    await expect(provider.close()).rejects.toBe(closeError)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("propagates public runtime cancellation to session abort and cleanup", async () => {
    const controller = new AbortController()
    const cancelled = new Error("cancelled")
    let notifyPromptStarted: (() => void) | undefined
    const promptStarted = new Promise<void>((resolve) => {
      notifyPromptStarted = resolve
    })
    const client = new RecordingSessionClient()
    client.prompt = async (
      input: OpenCodeSessionPromptInput,
      signal: AbortSignal,
    ) => {
      client.promptCalls.push({ input, signal })
      notifyPromptStarted?.()

      return await new Promise<OpenCodeSessionPromptResult>(
        (_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        },
      )
    }
    const provider = opencodeAgent({ sessionClient: client })
    const evaluation = new AmlRuntime({ agentProvider: provider }).evaluate(
      <Agent>cancel me</Agent>,
      { signal: controller.signal },
    )

    await promptStarted
    controller.abort(cancelled)

    await expect(evaluation).rejects.toMatchObject({
      cause: cancelled,
      message: 'Agent "opencode" (span-1) failed',
    })
    expect(client.abortCalls).toEqual([{ sessionId: "session-1" }])
    expect(client.deleteCalls).toEqual([{ sessionId: "session-1" }])
    await provider.close()
  })
})

describe("OpenCodeSession", () => {
  it("rejects capability attachment before creating a session", async () => {
    const attachError = new Error("attach failed")
    const client = new RecordingSessionClient()
    client.attachCapabilities = async () => {
      client.events.push("attach")
      throw attachError
    }

    await expect(
      new OpenCodeSession(client, {}).run(
        createRequest({
          tools: [{ kind: "host", name: "read" }],
        }),
        createContext(),
      ),
    ).rejects.toBe(attachError)
    expect(client.events).toEqual(["attach"])
    expect(client.createCalls).toHaveLength(0)
    expect(client.promptCalls).toHaveLength(0)
    expect(client.deleteCalls).toHaveLength(0)
  })

  it("closes a capability attachment when session creation fails", async () => {
    const createError = new Error("create failed")
    const client = new RecordingSessionClient()
    client.create = async (input, signal) => {
      client.events.push("create")
      client.createCalls.push({ input, signal })
      throw createError
    }

    await expect(
      new OpenCodeSession(client, {}).run(
        createRequest({
          tools: [{ kind: "host", name: "read" }],
        }),
        createContext(),
      ),
    ).rejects.toBe(createError)
    expect(client.events).toEqual(["attach", "create"])
    expect(client.capabilityAttachmentClose).toHaveBeenCalledTimes(1)
    expect(client.deleteCalls).toHaveLength(0)
  })

  it("preserves execution and cleanup failures", async () => {
    const promptError = new Error("prompt failed")
    const cleanupError = new Error("cleanup failed")
    const client = new RecordingSessionClient()
    client.prompt = async () => {
      throw promptError
    }
    client.delete = async (input) => {
      client.deleteCalls.push(input)
      throw cleanupError
    }

    const error = await new OpenCodeSession(client, {})
      .run(createRequest(), createContext())
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AggregateError)
    expect(error).toHaveProperty("errors", [promptError, cleanupError])
    expect(client.deleteCalls).toEqual([{ sessionId: "session-1" }])
  })

  it("preserves an undefined rejection reason", async () => {
    const client = new RecordingSessionClient()
    client.prompt = async () => {
      throw undefined
    }

    await expect(
      new OpenCodeSession(client, {}).run(
        createRequest(),
        createContext(),
      ),
    ).rejects.toBeUndefined()
    expect(client.deleteCalls).toEqual([{ sessionId: "session-1" }])
  })

  it("rejects assistant errors and malformed visible text after cleanup", async () => {
    const providerError = { name: "ProviderError" }
    const client = new RecordingSessionClient()
    client.promptResult = { error: providerError, parts: [] }

    const assistantError = await new OpenCodeSession(client, {})
      .run(createRequest(), createContext())
      .catch((cause: unknown) => cause)

    expect(assistantError).toHaveProperty(
      "message",
      "OpenCode returned an assistant error",
    )
    expect(assistantError).toHaveProperty("cause", providerError)
    expect(client.deleteCalls).toHaveLength(1)

    client.promptResult = { parts: [{ type: "text" }] }

    await expect(
      new OpenCodeSession(client, {}).run(
        createRequest(),
        createContext(),
      ),
    ).rejects.toThrow("OpenCode returned an invalid visible text part")
    expect(client.deleteCalls).toHaveLength(2)

    client.promptResult = {
      parts: [
        {
          synthetic: "true",
          text: "must not leak",
          type: "text",
        },
      ],
    }

    await expect(
      new OpenCodeSession(client, {}).run(
        createRequest(),
        createContext(),
      ),
    ).rejects.toThrow("OpenCode returned invalid response metadata")
    expect(client.deleteCalls).toHaveLength(3)
  })

  it("reads each provider text value once at the validation boundary", async () => {
    const client = new RecordingSessionClient()
    let reads = 0
    const part = Object.defineProperty(
      { type: "text" },
      "text",
      {
        get() {
          reads += 1
          return reads === 1 ? "stable" : { unvalidated: true }
        },
      },
    )
    client.promptResult = { parts: [part] }

    await expect(
      new OpenCodeSession(client, {}).run(
        createRequest(),
        createContext(),
      ),
    ).resolves.toEqual({ text: "stable" })
    expect(reads).toBe(1)
    expect(client.deleteCalls).toEqual([{ sessionId: "session-1" }])
  })

  it("accepts inherited structured values from an injected session port", async () => {
    const client = new RecordingSessionClient()
    let reads = 0
    const inherited = Object.create({
      get structured() {
        reads += 1
        return { count: 2 }
      },
    }) as OpenCodeSessionPromptResult

    Object.defineProperty(inherited, "parts", {
      enumerable: true,
      value: [],
    })
    client.promptResult = inherited

    await expect(
      new OpenCodeSession(client, {}).run(
        createRequest({
          output: {
            jsonSchema: {
              properties: { count: { type: "number" } },
              type: "object",
            },
            type: "json",
          },
        }),
        createContext(),
      ),
    ).resolves.toEqual({
      structured: { count: 2 },
      text: "",
    })
    expect(reads).toBe(1)
  })
})

describe("OpenCodeSdkClient", () => {
  it("preflights and grants structured output as an exact capability", async () => {
    const ids = vi.fn(async () => ({ data: [] }))
    const health = vi.fn(async () => ({
      data: { healthy: true, version: "1.18.5" },
    }))
    const client = new OpenCodeSdkClient({
      global: { health },
      tool: { ids },
    } as never)
    const signal = new AbortController().signal

    const attachment = await client.attachCapabilities(
      {
        context: createContext(signal),
        mcpServers: [],
        structuredOutput: true,
        tools: [],
      },
      signal,
    )

    expect(health).toHaveBeenCalledOnce()
    expect(ids).toHaveBeenCalledOnce()
    expect(attachment.tools).toEqual({
      "*": false,
      StructuredOutput: true,
    })
    await attachment.close()
  })

  it("rejects unreviewed servers for structured-only requests", async () => {
    const ids = vi.fn()
    const client = createSdkClient(
      { tool: { ids } },
      "1.19.0",
    )

    await expect(
      client.attachCapabilities(
        {
          context: createContext(),
          mcpServers: [],
          structuredOutput: true,
          tools: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      "OpenCode server 1.19.0 is unsupported for capability isolation",
    )
    expect(ids).not.toHaveBeenCalled()
  })

  it("rejects ambient host Tools that collide with structured output", async () => {
    const client = createSdkClient({
      tool: {
        ids: vi.fn(async () => ({
          data: ["StructuredOutput"],
        })),
      },
    })

    await expect(
      client.attachCapabilities(
        {
          context: createContext(),
          mcpServers: [],
          structuredOutput: true,
          tools: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      'OpenCode host Tool "StructuredOutput" is reserved by structured requests',
    )
  })

  it("rejects unreviewed OpenCode server versions before capability setup", async () => {
    const ids = vi.fn()
    const client = createSdkClient(
      {
        mcp: { status: vi.fn() },
        tool: { ids },
      },
      "1.19.0",
    )

    await expect(
      client.attachCapabilities(
        {
          context: createContext(),
          mcpServers: [],
          structuredOutput: false,
          tools: [{ kind: "host", name: "read" }],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      "OpenCode server 1.19.0 is unsupported for capability isolation",
    )
    expect(ids).not.toHaveBeenCalled()
  })

  it("rejects incompatible JavaScript Tools before session creation", async () => {
    const create = vi.fn()
    const scalar = defineTool({
      description: "Accept a scalar",
      input: z.string(),
      name: "scalar",
      execute: async (value) => value,
    })
    const client = createSdkClient({
      session: { create },
    } as never)

    await expect(
      new OpenCodeSession(client, {}).run(
        createRequest({ tools: [scalar] }),
        createContext(),
      ),
    ).rejects.toThrow(
      'OpenCode Tool "scalar" requires an object input schema',
    )
    expect(create).not.toHaveBeenCalled()
  })

  it("maps exact host Tools and rejects unavailable or wildcard grants", async () => {
    const rawClient = {
      mcp: {
        status: vi.fn(async () => ({ data: {} })),
      },
      tool: {
        ids: vi.fn(async () => ({
          data: ["read", "grep", "read*", "read?"],
        })),
      },
    }
    const client = createSdkClient(rawClient as never)
    const signal = new AbortController().signal

    const attachment = await client.attachCapabilities(
      {
        context: createContext(signal),
        mcpServers: [],
        structuredOutput: false,
        tools: [{ kind: "host", name: "read" }],
      },
      signal,
    )

    expect(attachment.tools).toEqual({ "*": false, read: true })
    await attachment.close()
    await expect(
      client.attachCapabilities(
        {
          context: createContext(signal),
          mcpServers: [],
          structuredOutput: false,
          tools: [{ kind: "host", name: "write" }],
        },
        signal,
      ),
    ).rejects.toThrow('OpenCode host Tool "write" is unavailable')

    await expect(
      client.attachCapabilities(
        {
          context: createContext(signal),
          mcpServers: [],
          structuredOutput: false,
          tools: [{ kind: "host", name: "read*" }],
        },
        signal,
      ),
    ).rejects.toThrow(
      'OpenCode host Tool "read*" contains wildcard syntax',
    )
    await expect(
      client.attachCapabilities(
        {
          context: createContext(signal),
          mcpServers: [],
          structuredOutput: false,
          tools: [{ kind: "host", name: "read?" }],
        },
        signal,
      ),
    ).rejects.toThrow(
      'OpenCode host Tool "read?" contains wildcard syntax',
    )
  })

  it("captures provider Tool IDs once before authorizing a host Tool", async () => {
    let reads = 0
    const ids = ["read"]

    Object.defineProperty(ids, 0, {
      enumerable: true,
      get() {
        reads += 1
        return reads === 1 ? "read" : "write"
      },
    })
    const client = createSdkClient({
      mcp: {
        status: vi.fn(async () => ({ data: {} })),
      },
      tool: {
        ids: vi.fn(async () => ({ data: ids })),
      },
    } as never)
    const signal = new AbortController().signal

    await expect(
      client.attachCapabilities(
        {
          context: createContext(signal),
          mcpServers: [],
          structuredOutput: false,
          tools: [{ kind: "host", name: "write" }],
        },
        signal,
      ),
    ).rejects.toThrow('OpenCode host Tool "write" is unavailable')
    expect(reads).toBe(1)
  })

  it("rejects exact host Tool IDs that overlap inherited MCP namespaces", async () => {
    const client = createSdkClient({
      mcp: {
        status: vi.fn(async () => ({
          data: { github: { status: "connected" } },
        })),
      },
      tool: {
        ids: vi.fn(async () => ({ data: ["github_admin"] })),
      },
    } as never)
    const signal = new AbortController().signal

    await expect(
      client.attachCapabilities(
        {
          context: createContext(signal),
          mcpServers: [],
          structuredOutput: false,
          tools: [{ kind: "host", name: "github_admin" }],
        },
        signal,
      ),
    ).rejects.toThrow(
      'OpenCode host Tool "github_admin" overlaps MCP server "github"',
    )
  })

  it("rejects provider Tool IDs that OpenCode treats as equivalent patterns", async () => {
    const client = createSdkClient({
      mcp: {
        status: vi.fn(async () => ({ data: {} })),
      },
      tool: {
        ids: vi.fn(async () => ({
          data: ["path\\read", "path/read"],
        })),
      },
    } as never)
    const signal = new AbortController().signal

    await expect(
      client.attachCapabilities(
        {
          context: createContext(signal),
          mcpServers: [],
          structuredOutput: false,
          tools: [{ kind: "host", name: "path\\read" }],
        },
        signal,
      ),
    ).rejects.toThrow(
      'OpenCode host Tool "path\\read" has permission-equivalent provider Tool IDs',
    )
  })

  it("mirrors OpenCode case-insensitive permission matching on Windows", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")

    if (!platform) {
      throw new Error("Node process.platform descriptor is unavailable")
    }

    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    })

    try {
      const signal = new AbortController().signal
      const statuses: Record<string, { status: string }> = {
        github: { status: "disabled" },
        GitHub_admin: { status: "connected" },
      }
      const client = createSdkClient({
        mcp: {
          connect: vi.fn(async ({ name }: { name: string }) => {
            statuses[name] = { status: "connected" }
            return { data: true }
          }),
          disconnect: vi.fn(async () => ({ data: true })),
          status: vi.fn(async () => ({ data: { ...statuses } })),
        },
        tool: {
          ids: vi.fn(async () => ({ data: [] })),
        },
      } as never)

      await expect(
        client.attachCapabilities(
          {
            context: createContext(signal),
            mcpServers: [{ kind: "named", name: "github" }],
            structuredOutput: false,
            tools: [],
          },
          signal,
        ),
      ).rejects.toThrow(
        'OpenCode MCP server "github" overlaps undeclared server "GitHub_admin"',
      )
    } finally {
      Object.defineProperty(process, "platform", platform)
    }
  })

  it("attaches named and configured MCP servers with scoped Tool namespaces", async () => {
    const statuses: Record<string, { status: string }> = {
      native: { status: "disabled" },
    }
    const mcp = {
      add: vi.fn(async (input: {
        config: unknown
        name: string
      }) => {
        statuses[input.name] = { status: "connected" }
        return { data: { ...statuses } }
      }),
      connect: vi.fn(async (input: { name: string }) => {
        statuses[input.name] = { status: "connected" }
        return { data: true }
      }),
      disconnect: vi.fn(async (input: { name: string }) => {
        statuses[input.name] = { status: "disabled" }
        return { data: true }
      }),
      status: vi.fn(async () => ({ data: { ...statuses } })),
    }
    const client = createSdkClient({
      mcp,
      tool: {
        ids: vi.fn(async () => ({ data: [] })),
      },
    } as never)
    const signal = new AbortController().signal
    const local = defineMcpServer({
      name: "project-db",
      transport: {
        args: ["server.mjs"],
        command: "node",
        env: { TOKEN: "secret" },
        type: "stdio",
      },
    })
    const remote = defineMcpServer({
      name: "remote.api",
      transport: {
        headers: { Authorization: "Bearer secret" },
        type: "streamable-http",
        url: "https://example.com/mcp",
      },
    })
    const attachment = await client.attachCapabilities(
      {
        context: createContext(signal),
        mcpServers: [
          { kind: "named", name: "native" },
          { definition: local, kind: "configured" },
          { definition: remote, kind: "configured" },
        ],
        structuredOutput: false,
        tools: [],
      },
      signal,
    )

    expect(mcp.connect).toHaveBeenCalledWith(
      { name: "native" },
      { signal, throwOnError: true },
    )
    expect(mcp.add.mock.calls.map(([input]) => input)).toEqual([
      {
        config: {
          command: ["node", "server.mjs"],
          enabled: true,
          environment: { TOKEN: "secret" },
          type: "local",
        },
        name: "project-db",
      },
      {
        config: {
          enabled: true,
          headers: { Authorization: "Bearer secret" },
          type: "remote",
          url: "https://example.com/mcp",
        },
        name: "remote.api",
      },
    ])
    expect(attachment.tools).toEqual({
      "*": false,
      "native_*": true,
      "project-db_*": true,
      "remote_api_*": true,
    })

    await attachment.close()
    await attachment.close()
    expect(
      mcp.disconnect.mock.calls.map(([input]) => input.name),
    ).toEqual(["remote.api", "project-db", "native"])
  })

  it("fails closed for unavailable, colliding, or unsupported MCP grants", async () => {
    const signal = new AbortController().signal
    const mcp = {
      add: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(async () => ({ data: true })),
      status: vi.fn(async () => ({ data: {} })),
    }
    const client = createSdkClient({ mcp } as never)

    await expect(
      client.attachCapabilities(
        {
          context: createContext(signal),
          mcpServers: [{ kind: "named", name: "missing" }],
          structuredOutput: false,
          tools: [],
        },
        signal,
      ),
    ).rejects.toThrow(
      'OpenCode named MCP server "missing" is unavailable',
    )

    const withCwd = defineMcpServer({
      name: "local",
      transport: {
        command: "node",
        cwd: "/different",
        type: "stdio",
      },
    })

    await expect(
      client.attachCapabilities(
        {
          context: createContext(signal),
          mcpServers: [
            { definition: withCwd, kind: "configured" },
          ],
          structuredOutput: false,
          tools: [],
        },
        signal,
      ),
    ).rejects.toThrow(
      'OpenCode does not support cwd for MCP server "local"',
    )

    await expect(
      client.attachCapabilities(
        {
          context: createContext(signal),
          mcpServers: [
            { kind: "named", name: "same.name" },
            { kind: "named", name: "same_name" },
          ],
          structuredOutput: false,
          tools: [],
        },
        signal,
      ),
    ).rejects.toThrow(
      "OpenCode MCP server names collide after provider normalization",
    )
    await expect(
      client.attachCapabilities(
        {
          context: createContext(signal),
          mcpServers: [
            { kind: "named", name: "github" },
            { kind: "named", name: "github_admin" },
          ],
          structuredOutput: false,
          tools: [],
        },
        signal,
      ),
    ).rejects.toThrow(
      "OpenCode MCP server names overlap after provider normalization",
    )
    expect(mcp.add).not.toHaveBeenCalled()
    expect(mcp.connect).not.toHaveBeenCalled()
  })

  it("rejects MCP namespace patterns that include undeclared capabilities", async () => {
    const signal = new AbortController().signal
    const statuses: Record<string, { status: string }> = {
      github: { status: "disabled" },
      github_admin: { status: "connected" },
    }
    const disconnect = vi.fn(async ({ name }: { name: string }) => {
      statuses[name] = { status: "disabled" }
      return { data: true }
    })
    const mcp = {
      connect: vi.fn(async ({ name }: { name: string }) => {
        statuses[name] = { status: "connected" }
        return { data: true }
      }),
      disconnect,
      status: vi.fn(async () => ({ data: { ...statuses } })),
    }
    const tool = {
      ids: vi.fn(async () => ({ data: [] as string[] })),
    }
    const client = createSdkClient({ mcp, tool } as never)

    await expect(
      client.attachCapabilities(
        {
          context: createContext(signal),
          mcpServers: [{ kind: "named", name: "github" }],
          structuredOutput: false,
          tools: [],
        },
        signal,
      ),
    ).rejects.toThrow(
      'OpenCode MCP server "github" overlaps undeclared server "github_admin"',
    )
    expect(disconnect).toHaveBeenCalledWith(
      { name: "github" },
      { throwOnError: true },
    )

    delete statuses.github_admin
    tool.ids.mockResolvedValueOnce({
      data: ["github_admin"],
    })
    await expect(
      client.attachCapabilities(
        {
          context: createContext(signal),
          mcpServers: [{ kind: "named", name: "github" }],
          structuredOutput: false,
          tools: [],
        },
        signal,
      ),
    ).rejects.toThrow(
      'OpenCode MCP server "github" overlaps undeclared host Tool "github_admin"',
    )
    expect(disconnect).toHaveBeenCalledTimes(2)

    statuses.github = { status: "connected" }
    statuses.github_admin = { status: "disabled" }
    tool.ids.mockResolvedValueOnce({ data: [] })
    await expect(
      client.attachCapabilities(
        {
          context: createContext(signal),
          mcpServers: [{ kind: "named", name: "github_admin" }],
          structuredOutput: false,
          tools: [],
        },
        signal,
      ),
    ).rejects.toThrow(
      'OpenCode MCP server "github_admin" overlaps undeclared server "github"',
    )
    expect(disconnect).toHaveBeenCalledTimes(3)
  })

  it("cleans partial MCP attachment and preserves setup causality", async () => {
    const signal = new AbortController().signal
    const statuses: Record<string, { status: string }> = {}
    const disconnect = vi.fn(async ({ name }: { name: string }) => {
      statuses[name] = { status: "disabled" }
      return { data: true }
    })
    const mcp = {
      add: vi.fn(async ({ name }: { name: string }) => {
        statuses[name] = { status: "connected" }
        return { data: { ...statuses } }
      }),
      connect: vi.fn(),
      disconnect,
      status: vi.fn(async () => ({ data: { ...statuses } })),
    }
    const client = createSdkClient({ mcp } as never)
    const first = defineMcpServer({
      name: "first",
      transport: {
        type: "streamable-http",
        url: "https://example.com/first",
      },
    })

    await expect(
      client.attachCapabilities(
        {
          context: createContext(signal),
          mcpServers: [
            { definition: first, kind: "configured" },
            { kind: "named", name: "missing" },
          ],
          structuredOutput: false,
          tools: [],
        },
        signal,
      ),
    ).rejects.toThrow(
      'OpenCode named MCP server "missing" is unavailable',
    )
    expect(disconnect).toHaveBeenCalledWith(
      { name: "first" },
      { throwOnError: true },
    )

    const setupFailure = new Error("MCP add response failed")
    const cleanupFailure = new Error("MCP disconnect failed")
    delete statuses.first
    mcp.add.mockRejectedValueOnce(setupFailure)
    disconnect.mockRejectedValueOnce(cleanupFailure)
    const error = await client
      .attachCapabilities(
        {
          context: createContext(signal),
          mcpServers: [
            { definition: first, kind: "configured" },
          ],
          structuredOutput: false,
          tools: [],
        },
        signal,
      )
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AggregateError)
    expect(error).toHaveProperty("errors", [
      setupFailure,
      cleanupFailure,
    ])
  })

  it("serves JavaScript Tools through an invocation-scoped MCP bridge", async () => {
    let bridgeClient: McpClient | undefined
    let bridgeName: string | undefined
    const mcp = {
      add: vi.fn(async (input: {
        config: {
          headers: Record<string, string>
          url: string
        }
        name: string
      }) => {
        bridgeName = input.name
        bridgeClient = new McpClient({
          name: "opencode-test",
          version: "0.0.0",
        })
        await bridgeClient.connect(
          new StreamableHTTPClientTransport(
            new URL(input.config.url),
            {
              requestInit: {
                headers: { ...input.config.headers },
              },
            },
          ) as never,
        )

        return {
          data: {
            [input.name]: { status: "connected" },
          },
        }
      }),
      disconnect: vi.fn(async () => {
        await bridgeClient?.close()
        return { data: true }
      }),
    }
    const rawClient = {
      mcp,
      tool: {
        ids: vi.fn(async () => ({ data: [] })),
      },
    }
    const execute = vi.fn(async ({ id }: { id: number }) => ({
      id,
      status: "active",
    }))
    const lookup = defineTool({
      description: "Look up a customer",
      execute,
      input: z.object({ id: z.number() }),
      name: "lookup_customer",
    })
    const signal = new AbortController().signal
    const client = createSdkClient(rawClient as never)
    const attachment = await client.attachCapabilities(
      {
        context: createContext(signal),
        mcpServers: [],
        structuredOutput: false,
        tools: [lookup],
      },
      signal,
    )

    expect(attachment.tools).toEqual({
      "*": false,
      [`${bridgeName}_lookup_customer`]: true,
    })
    await expect(bridgeClient!.listTools()).resolves.toMatchObject({
      tools: [
        {
          description: "Look up a customer",
          name: "lookup_customer",
        },
      ],
    })
    await expect(
      bridgeClient!.callTool({
        arguments: { id: 42 },
        name: "lookup_customer",
      }),
    ).resolves.toMatchObject({
      content: [
        {
          text: '{"id":42,"status":"active"}',
          type: "text",
        },
      ],
    })
    expect(execute).toHaveBeenCalledWith(
      { id: 42 },
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        trace: createContext().trace,
      }),
    )

    await attachment.close()
    await attachment.close()
    expect(mcp.disconnect).toHaveBeenCalledTimes(1)
  })

  it("preserves attachment setup and cleanup failures", async () => {
    const disconnectError = new Error("disconnect failed")
    const mcp = {
      add: vi.fn(async ({ name }: { name: string }) => ({
        data: { [name]: { status: "connected" } },
      })),
      disconnect: vi.fn(async () => {
        throw disconnectError
      }),
      status: vi.fn(async () => ({ data: {} })),
    }
    const client = createSdkClient({
      mcp,
      tool: {
        ids: vi.fn(async () => ({ data: [] })),
      },
    } as never)
    const lookup = defineTool({
      description: "Look up a customer",
      input: z.object({ id: z.number() }),
      name: "lookup_customer",
      execute: async ({ id }) => ({ id }),
    })
    const error = await client
      .attachCapabilities(
        {
          context: createContext(),
          mcpServers: [],
          structuredOutput: false,
          tools: [
            lookup,
            { kind: "host", name: "missing" },
          ],
        },
        new AbortController().signal,
      )
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AggregateError)
    expect(error).toHaveProperty("errors", [
      expect.objectContaining({
        message: 'OpenCode host Tool "missing" is unavailable',
      }),
      disconnectError,
    ])
  })

  it("maps the AML session port to the generated v2 SDK", async () => {
    const signal = new AbortController().signal
    const textPart = { text: "response", type: "text" }
    const rawClient = {
      session: {
        abort: vi.fn(async () => ({ data: true })),
        create: vi.fn(async () => ({ data: { id: "session-id" } })),
        delete: vi.fn(async () => ({ data: true })),
        prompt: vi.fn(async () => ({
          data: {
            info: {
              error: undefined,
              structured: { answer: 42 },
            },
            parts: [textPart],
          },
        })),
      },
    }
    const client = createSdkClient(rawClient as never)
    const model = { modelId: "model", providerId: "provider" }

    await expect(
      client.create(
        { directory: "/workspace", model, title: "AML span-1" },
        signal,
      ),
    ).resolves.toBe("session-id")
    await expect(
      client.prompt(
        {
          directory: "/workspace",
          model,
          output: {
            jsonSchema: {
              properties: { answer: { type: "number" } },
              type: "object",
            },
            type: "json",
          },
          prompt: "prompt",
          sessionId: "session-id",
          system: "system",
          tools: { "*": false },
        },
        signal,
      ),
    ).resolves.toEqual({
      parts: [textPart],
      structured: { answer: 42 },
    })
    await client.abort({
      directory: "/workspace",
      sessionId: "session-id",
    })
    await client.delete({
      directory: "/workspace",
      sessionId: "session-id",
    })

    expect(rawClient.session.create).toHaveBeenCalledWith(
      {
        directory: "/workspace",
        model: { id: "model", providerID: "provider" },
        title: "AML span-1",
      },
      { signal, throwOnError: true },
    )
    expect(rawClient.session.prompt).toHaveBeenCalledWith(
      {
        directory: "/workspace",
        format: {
          schema: {
            properties: { answer: { type: "number" } },
            type: "object",
          },
          type: "json_schema",
        },
        model: { modelID: "model", providerID: "provider" },
        parts: [{ text: "prompt", type: "text" }],
        sessionID: "session-id",
        system: "system",
        tools: { "*": false },
      },
      { signal, throwOnError: true },
    )
  })

  it("captures and validates raw assistant metadata once", async () => {
    const assistantError = { name: "ProviderError" }
    let errorReads = 0
    const info = Object.defineProperty({}, "error", {
      get() {
        errorReads += 1
        return errorReads === 1 ? assistantError : undefined
      },
    })
    const rawClient = {
      session: {
        prompt: vi.fn(async () => ({
          data: {
            info,
            parts: [{ text: "must not mask the error", type: "text" }],
          },
        })),
      },
    }
    const client = createSdkClient(rawClient as never)
    const input: OpenCodeSessionPromptInput = {
      prompt: "prompt",
      sessionId: "session-id",
      system: "",
      tools: { "*": false },
    }
    const signal = new AbortController().signal

    await expect(client.prompt(input, signal)).resolves.toEqual({
      error: assistantError,
      parts: [{ text: "must not mask the error", type: "text" }],
    })
    expect(errorReads).toBe(1)

    rawClient.session.prompt.mockResolvedValueOnce({
      data: {
        info: "invalid",
        parts: [],
      },
    } as never)

    await expect(client.prompt(input, signal)).rejects.toThrow(
      "OpenCode returned invalid assistant metadata",
    )
  })

  it("rejects every non-true abort and delete acknowledgement", async () => {
    const rawClient = {
      session: {
        abort: vi.fn(async () => ({ data: "yes" })),
        delete: vi.fn(async () => ({ data: { ok: true } })),
      },
    }
    const client = createSdkClient(rawClient as never)

    await expect(client.abort({ sessionId: "session-id" })).rejects.toThrow(
      "OpenCode did not abort session session-id",
    )
    await expect(client.delete({ sessionId: "session-id" })).rejects.toThrow(
      "OpenCode did not delete session session-id",
    )
  })
})
