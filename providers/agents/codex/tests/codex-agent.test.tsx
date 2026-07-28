import { Agent, AmlRuntime, defineMcpServer, defineTool, evaluate, FollowUp, Mcp, Tool } from "@aml-jsx/sdk"
import type { AgentRequest } from "@aml-jsx/sdk"
import { agentProviderConformance, createAgentExecutionContext } from "@aml-jsx/sdk/testing"
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { z } from "zod"
import { describe, expect, it, vi } from "vitest"

import {
  codexAgent,
  type CodexAgentOptions,
  type CodexClient,
  type CodexClientFactory,
  type CodexClientOptions,
  type CodexThreadOptions,
  type CodexTurnOptions,
  type CodexTurnResult,
} from "../src/index.js"

interface RecordedTurn {
  readonly options: CodexTurnOptions
  readonly prompt: string
  readonly threadIndex: number
}

/**
 * Deterministic Codex construction port used by adapter boundary tests.
 */
class RecordingClientFactory implements CodexClientFactory {
  readonly clientOptions: CodexClientOptions[] = []
  readonly threadOptions: CodexThreadOptions[] = []
  readonly turns: RecordedTurn[] = []
  response: (prompt: string, options: CodexTurnOptions, threadIndex: number) => Promise<CodexTurnResult> =
    async prompt => ({
      finalResponse: `response:${prompt}`,
    })

  /**
   * Records one invocation-local client and returns a fresh-thread fake.
   */
  create(options: CodexClientOptions): CodexClient {
    this.clientOptions.push(options)

    return {
      startThread: threadOptions => {
        const threadIndex = this.threadOptions.length
        this.threadOptions.push(threadOptions)

        return {
          run: async (prompt, turnOptions) => {
            this.turns.push({
              options: turnOptions,
              prompt,
              threadIndex,
            })
            return await this.response(prompt, turnOptions, threadIndex)
          },
        }
      },
    }
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

function createContext(signal = new AbortController().signal): ReturnType<typeof createAgentExecutionContext> {
  return createAgentExecutionContext({
    signal,
    trace: {
      runId: "run",
      spanId: "span-1",
    },
  })
}

/**
 * Reads the invocation-local Tool bridge from captured Codex configuration.
 */
function requireToolBridge(clientFactory: RecordingClientFactory): Readonly<{
  headers: Readonly<Record<string, string>>
  url: string
}> {
  const config = clientFactory.clientOptions.at(-1)?.config.mcp_servers

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("missing Codex MCP configuration")
  }

  const bridge = Object.values(config as Record<string, unknown>).find(
    entry =>
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      typeof Reflect.get(entry, "url") === "string" &&
      (Reflect.get(entry, "url") as string).startsWith("http://127.0.0.1:")
  )

  if (
    typeof bridge !== "object" ||
    bridge === null ||
    Array.isArray(bridge) ||
    typeof Reflect.get(bridge, "url") !== "string" ||
    typeof Reflect.get(bridge, "http_headers") !== "object" ||
    Reflect.get(bridge, "http_headers") === null ||
    Array.isArray(Reflect.get(bridge, "http_headers"))
  ) {
    throw new Error("missing Codex Tool bridge")
  }

  return Object.freeze({
    headers: Reflect.get(bridge, "http_headers") as Record<string, string>,
    url: Reflect.get(bridge, "url") as string,
  })
}

describe("codexAgent", () => {
  it("is side-effect-free, immutable, and SDK-conformant", async () => {
    const clientFactory = new RecordingClientFactory()
    const provider = codexAgent({
      clientFactory,
      config: {
        custom: "retained",
        features: { custom_feature: true },
      },
      model: "gpt-5.3-codex-spark",
      reasoningEffort: "high",
      skipGitRepoCheck: true,
      workingDirectory: "/workspace",
    })

    expect(clientFactory.clientOptions).toHaveLength(0)
    expect(Object.isFrozen(provider)).toBe(true)
    expect(provider.name).toBe("codex")

    await expect(agentProviderConformance(provider)).resolves.toBeUndefined()

    expect(clientFactory.clientOptions).toHaveLength(1)
    expect(clientFactory.clientOptions[0]?.config).toEqual({
      agents: { enabled: false },
      custom: "retained",
      developer_instructions: "Follow the provider contract.",
      features: {
        custom_feature: true,
        multi_agent: false,
        shell_tool: false,
        unified_exec: false,
      },
      mcp_servers: {},
    })
    expect(clientFactory.threadOptions).toEqual([
      {
        approvalPolicy: "never",
        model: "gpt-5.3-codex-spark",
        modelReasoningEffort: "high",
        networkAccessEnabled: false,
        sandboxMode: "read-only",
        skipGitRepoCheck: true,
        webSearchMode: "disabled",
        workingDirectory: "/workspace",
      },
    ])
    expect(clientFactory.turns.map(({ prompt }) => prompt)).toEqual([
      "agent-provider-conformance",
      "agent-provider-conformance-final",
    ])
  })

  it("creates fresh threads and applies per-Agent model precedence", async () => {
    const clientFactory = new RecordingClientFactory()
    const provider = codexAgent({
      clientFactory,
      model: "gpt-5.3-codex-spark",
    })
    const runtime = new AmlRuntime({
      agentProvider: provider,
      system: "runtime system",
    })

    await expect(runtime.evaluate([<Agent>first</Agent>, <Agent model="gpt-5.4">second</Agent>])).resolves.toBe(
      "response:firstresponse:second"
    )

    expect(clientFactory.threadOptions.map(({ model }) => model)).toEqual(["gpt-5.3-codex-spark", "gpt-5.4"])
    expect(clientFactory.clientOptions.map(({ config }) => config.developer_instructions)).toEqual([
      "runtime system",
      "runtime system",
    ])
  })

  it("applies structured output only to the final FollowUp", async () => {
    const clientFactory = new RecordingClientFactory()
    clientFactory.response = async (_prompt, options) => ({
      finalResponse: options.outputSchema === undefined ? "intermediate" : '{"count":3}',
    })
    const provider = codexAgent({ clientFactory })
    const Result = z.object({ count: z.number() })

    async function Workflow() {
      const result = await evaluate(
        <Agent provider={provider}>
          Count findings.
          <FollowUp>Return the final structured count.</FollowUp>
        </Agent>,
        Result
      )

      return `count:${result.count}`
    }

    await expect(new AmlRuntime().evaluate(<Workflow />)).resolves.toBe("count:3")
    expect(clientFactory.turns).toHaveLength(2)
    expect(clientFactory.turns[0]?.options.outputSchema).toBeUndefined()
    expect(clientFactory.turns[1]?.options.outputSchema).toMatchObject({
      additionalProperties: false,
      properties: { count: { type: "number" } },
      type: "object",
    })
  })

  it("rejects optional structured properties before starting Codex", async () => {
    const clientFactory = new RecordingClientFactory()
    const provider = codexAgent({ clientFactory })
    const Result = z.object({
      count: z.number().optional(),
    })

    async function Workflow() {
      await evaluate(<Agent provider={provider}>Count findings.</Agent>, Result)
      return "unreachable"
    }

    const error = await new AmlRuntime().evaluate(<Workflow />).catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      cause: {
        message: "Codex output schema $ has optional properties unsupported by strict output: count",
      },
      message: 'Agent "codex" (span-1) failed',
    })
    expect(clientFactory.clientOptions).toHaveLength(0)
  })

  it("closes object schemas across standard nested schema containers", async () => {
    const clientFactory = new RecordingClientFactory()
    clientFactory.response = async () => ({
      finalResponse: '{"__proto__":"safe"}',
    })
    const provider = codexAgent({ clientFactory })
    const schemaProperties = Object.fromEntries([["__proto__", { type: "string" }]])

    await provider.run(
      createRequest({
        output: {
          jsonSchema: {
            $defs: {
              nullableRecord: {
                type: ["object", "null"],
              },
              record: {
                properties: {
                  value: { type: "string" },
                },
                required: ["value"],
                type: "object",
              },
            },
            contains: {
              properties: {
                contained: { type: "boolean" },
              },
              required: ["contained"],
              type: "object",
            },
            prefixItems: [
              {
                properties: {
                  indexed: { type: "number" },
                },
                required: ["indexed"],
                type: "object",
              },
            ],
            properties: schemaProperties,
            required: ["__proto__"],
            then: {
              properties: {
                conditional: { type: "string" },
              },
              required: ["conditional"],
              type: "object",
            },
            type: "object",
          },
          type: "json",
        },
      }),
      createContext()
    )

    const outputSchema = clientFactory.turns[0]?.options.outputSchema
    const properties = outputSchema?.properties as Record<string, unknown> | undefined

    expect(outputSchema?.additionalProperties).toBe(false)
    expect(Object.hasOwn(properties ?? {}, "__proto__")).toBe(true)
    expect(
      ((outputSchema?.$defs as Record<string, unknown>).record as Record<string, unknown>).additionalProperties
    ).toBe(false)
    expect(
      ((outputSchema?.$defs as Record<string, unknown>).nullableRecord as Record<string, unknown>).additionalProperties
    ).toBe(false)
    expect(
      ((outputSchema?.prefixItems as Record<string, unknown>[])[0] as Record<string, unknown>).additionalProperties
    ).toBe(false)
    expect((outputSchema?.contains as Record<string, unknown>).additionalProperties).toBe(false)
    expect((outputSchema?.then as Record<string, unknown>).additionalProperties).toBe(false)
  })

  it("rejects schema-valued additional properties before starting Codex", async () => {
    const clientFactory = new RecordingClientFactory()
    const provider = codexAgent({ clientFactory })

    await expect(
      provider.run(
        createRequest({
          output: {
            jsonSchema: {
              additionalProperties: {
                properties: {
                  nested: { type: "string" },
                },
                required: ["nested"],
                type: "object",
              },
            },
            type: "json",
          },
        }),
        createContext()
      )
    ).rejects.toThrow("Codex output schema $.additionalProperties must be false")
    expect(clientFactory.clientOptions).toHaveLength(0)
  })

  it("enforces the exact output-schema depth boundary", async () => {
    const clientFactory = new RecordingClientFactory()
    clientFactory.response = async () => ({
      finalResponse: '"accepted"',
    })
    const provider = codexAgent({ clientFactory })
    let acceptedSchema: Record<string, unknown> = {
      type: "string",
    }

    for (let depth = 0; depth < 128; depth += 1) {
      acceptedSchema = { not: acceptedSchema }
    }

    await expect(
      provider.run(
        createRequest({
          output: {
            jsonSchema: acceptedSchema as never,
            type: "json",
          },
        }),
        createContext()
      )
    ).resolves.toMatchObject({ structured: "accepted" })
    expect(clientFactory.clientOptions).toHaveLength(1)

    const rejectedSchema = { not: acceptedSchema }

    await expect(
      provider.run(
        createRequest({
          output: {
            jsonSchema: rejectedSchema as never,
            type: "json",
          },
        }),
        createContext()
      )
    ).rejects.toThrow("Codex output schema exceeds the maximum depth of 128")
    expect(clientFactory.clientOptions).toHaveLength(1)
  })

  it("rejects invalid structured JSON at the provider boundary", async () => {
    const clientFactory = new RecordingClientFactory()
    clientFactory.response = async () => ({
      finalResponse: "not-json",
    })
    const provider = codexAgent({ clientFactory })

    await expect(
      provider.run(
        createRequest({
          output: {
            jsonSchema: { type: "object" },
            type: "json",
          },
        }),
        createContext()
      )
    ).rejects.toThrow("Codex structured response is not valid JSON")
  })

  it("maps declared MCP grants without discarding inherited configuration", async () => {
    const clientFactory = new RecordingClientFactory()
    const provider = codexAgent({
      clientFactory,
      config: {
        mcp_servers: {
          inherited: {
            command: "existing-command",
            enabled: false,
          },
          unrelated: {
            command: "ambient-command",
          },
        },
      },
    })
    const stdio = defineMcpServer({
      name: "local-tools",
      transport: {
        args: ["server.js"],
        command: "node",
        cwd: "/workspace",
        env: { TOKEN: "secret" },
        type: "stdio",
      },
    })
    const remote = defineMcpServer({
      name: "remote-tools",
      transport: {
        headers: { Authorization: "Bearer remote" },
        type: "streamable-http",
        url: "https://mcp.example.test",
      },
    })

    await new AmlRuntime({ agentProvider: provider }).evaluate(
      <Agent>
        <Mcp name="ambient-only" />
        <Mcp name="inherited" />
        <Mcp use={stdio} />
        <Mcp use={remote} />
        inspect
      </Agent>
    )

    expect(clientFactory.clientOptions[0]?.config.mcp_servers).toEqual({
      "ambient-only": {
        default_tools_approval_mode: "approve",
        enabled: true,
        required: true,
      },
      inherited: {
        command: "existing-command",
        default_tools_approval_mode: "approve",
        enabled: true,
        required: true,
      },
      "local-tools": {
        args: ["server.js"],
        command: "node",
        cwd: "/workspace",
        default_tools_approval_mode: "approve",
        enabled: true,
        env: { TOKEN: "secret" },
        required: true,
      },
      "remote-tools": {
        default_tools_approval_mode: "approve",
        enabled: true,
        http_headers: {
          Authorization: "Bearer remote",
        },
        required: true,
        url: "https://mcp.example.test/",
      },
      unrelated: {
        command: "ambient-command",
      },
    })
  })

  it("rejects malformed explicit configuration for a named MCP grant", async () => {
    const clientFactory = new RecordingClientFactory()
    const provider = codexAgent({
      clientFactory,
      config: {
        mcp_servers: {
          project: "not-a-server-table",
        },
      },
    })

    await expect(
      provider.run(
        createRequest({
          mcpServers: [{ kind: "named", name: "project" }],
        }),
        createContext()
      )
    ).rejects.toThrow('Codex MCP server "project" configuration must be an object')
    expect(clientFactory.clientOptions).toHaveLength(0)
  })

  it("preserves prototype-sensitive configuration and MCP names as data", async () => {
    const clientFactory = new RecordingClientFactory()
    const inheritedServers = Object.fromEntries([
      [
        "__proto__",
        {
          command: "prototype-server",
          enabled: false,
        },
      ],
    ])
    const config = Object.fromEntries([
      ["__proto__", { marker: "configuration-data" }],
      ["mcp_servers", inheritedServers],
    ])
    const env = Object.fromEntries([["__proto__", "environment-data"]])
    const provider = codexAgent({
      clientFactory,
      config,
      env,
    })

    await new AmlRuntime({ agentProvider: provider }).evaluate(
      <Agent>
        <Mcp name="__proto__" />
        inspect
      </Agent>
    )

    const clientOptions = clientFactory.clientOptions[0]
    const mcpServers = clientOptions?.config.mcp_servers as Record<string, unknown> | undefined

    expect(Object.hasOwn(clientOptions?.config ?? {}, "__proto__")).toBe(true)
    expect(Reflect.get(clientOptions?.config ?? {}, "__proto__")).toEqual({ marker: "configuration-data" })
    expect(Object.hasOwn(clientOptions?.env ?? {}, "__proto__")).toBe(true)
    expect(Reflect.get(clientOptions?.env ?? {}, "__proto__")).toBe("environment-data")
    expect(Object.hasOwn(mcpServers ?? {}, "__proto__")).toBe(true)
    expect(Reflect.get(mcpServers ?? {}, "__proto__")).toEqual({
      command: "prototype-server",
      default_tools_approval_mode: "approve",
      enabled: true,
      required: true,
    })
  })

  it("maps read aliases to one shell boundary and rejects wider host Tools", async () => {
    const clientFactory = new RecordingClientFactory()
    const provider = codexAgent({ clientFactory })

    await new AmlRuntime({ agentProvider: provider }).evaluate(
      <Agent>
        <Tool name="grep" />
        inspect
      </Agent>
    )

    expect(
      (
        clientFactory.clientOptions[0]?.config.features as {
          shell_tool: boolean
          unified_exec: boolean
        }
      ).shell_tool
    ).toBe(true)
    expect(
      (
        clientFactory.clientOptions[0]?.config.features as {
          shell_tool: boolean
          unified_exec: boolean
        }
      ).unified_exec
    ).toBe(true)

    const error = await new AmlRuntime({
      agentProvider: provider,
    })
      .evaluate(
        <Agent>
          <Tool name="bash" />
          mutate
        </Agent>
      )
      .catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      cause: {
        message: 'Codex host Tool "bash" is unsupported',
      },
      message: 'Agent "codex" (span-1) failed',
    })
    expect(clientFactory.clientOptions).toHaveLength(1)
  })

  it("serves JavaScript Tools to a fresh MCP session for every FollowUp", async () => {
    const secret = "codex-tool-result"
    let toolCalls = 0
    const lookup = defineTool({
      description: "Return the Codex adapter fixture",
      input: z.object({}),
      name: "lookup_codex_fixture",
      async execute() {
        toolCalls += 1
        return secret
      },
    })
    const clientFactory = new RecordingClientFactory()
    clientFactory.response = async () => {
      const { headers, url } = requireToolBridge(clientFactory)

      // Every Codex SDK turn starts a new CLI process, so deliberately connect
      // and initialize a fresh MCP client for each recorded FollowUp.
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
          headers,
        },
      })
      const client = new McpClient({
        name: "codex-adapter-test",
        version: "0.0.0",
      })

      try {
        // MCP 1.29's exact optional transport declarations disagree across
        // its client and concrete Streamable HTTP packages.
        await client.connect(transport as never)
        const result = await client.callTool({
          arguments: {},
          name: "lookup_codex_fixture",
        })
        const contentList = Reflect.get(result, "content")
        const content = Array.isArray(contentList) ? contentList[0] : undefined

        if (
          typeof content !== "object" ||
          content === null ||
          Reflect.get(content, "type") !== "text" ||
          typeof Reflect.get(content, "text") !== "string"
        ) {
          throw new Error("Codex Tool returned non-text content")
        }

        return {
          finalResponse: Reflect.get(content, "text") as string,
        }
      } finally {
        await client.close()
      }
    }
    const provider = codexAgent({ clientFactory })

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          <Tool use={lookup} />
          first
          <FollowUp>second</FollowUp>
        </Agent>
      )
    ).resolves.toBe(secret)
    expect(toolCalls).toBe(2)
    expect(clientFactory.turns).toHaveLength(2)
    expect(clientFactory.clientOptions[0]?.config.developer_instructions).toContain(
      "When the requested Tool is deferred, use Codex tool discovery with its exact name"
    )
  })

  it("waits for aborted JavaScript Tool cleanup before the Agent settles", async () => {
    let notifyAborted!: () => void
    let notifyStarted!: () => void
    let releaseCleanup!: () => void
    const aborted = new Promise<void>(resolve => {
      notifyAborted = resolve
    })
    const cleanup = new Promise<void>(resolve => {
      releaseCleanup = resolve
    })
    const started = new Promise<void>(resolve => {
      notifyStarted = resolve
    })
    const slowTool = defineTool({
      description: "Wait for provider cleanup",
      input: z.object({}),
      name: "wait_for_cleanup",
      async execute(_input, context) {
        notifyStarted()

        if (!context.signal.aborted) {
          await new Promise<void>(resolve => {
            context.signal.addEventListener("abort", () => resolve(), { once: true })
          })
        }

        notifyAborted()
        await cleanup
        return "clean"
      },
    })
    const clientFactory = new RecordingClientFactory()
    clientFactory.response = async () => {
      const { headers, url } = requireToolBridge(clientFactory)
      const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })
      const client = new McpClient({
        name: "codex-cleanup-test",
        version: "0.0.0",
      })

      await client.connect(transport as never)
      const call = client.callTool({
        arguments: {},
        name: "wait_for_cleanup",
      })

      // Return the provider turn while its Tool remains active. The adapter,
      // not this injected client, must keep the Agent boundary open.
      await started
      void call.finally(async () => await client.close()).catch(() => undefined)
      return { finalResponse: "provider finished" }
    }
    const provider = codexAgent({ clientFactory })
    const pending = new AmlRuntime({
      agentProvider: provider,
    }).evaluate(
      <Agent>
        <Tool use={slowTool} />
        run
      </Agent>
    )

    await aborted
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)

    releaseCleanup()
    await expect(pending).resolves.toBe("provider finished")
  })

  it("validates adapter configuration synchronously and snapshots it", async () => {
    const clientFactory = new RecordingClientFactory()
    const config = {
      custom: {
        values: ["before"],
      },
    }
    const env = { FIXTURE: "before" }
    const provider = codexAgent({
      clientFactory,
      config,
      env,
    })

    config.custom.values[0] = "after"
    env.FIXTURE = "after"
    await provider.run(createRequest(), createContext())

    expect(clientFactory.clientOptions[0]).toMatchObject({
      config: {
        custom: {
          values: ["before"],
        },
      },
      env: { FIXTURE: "before" },
    })
    expect(() =>
      codexAgent({
        reasoningEffort: "extreme" as never,
      })
    ).toThrow("Codex reasoningEffort is unsupported")
    expect(() =>
      codexAgent({
        config: { features: false },
      })
    ).toThrow("Codex config features must be an object")
    expect(() =>
      codexAgent({
        clientFactory: {} as never,
      })
    ).toThrow("Codex clientFactory create must be a function")
    expect(() =>
      codexAgent({
        clientFactory: null as never,
      })
    ).toThrow("Codex clientFactory create must be a function")
    expect(() =>
      codexAgent({
        config: null as never,
      })
    ).toThrow("Codex config must be a plain object")
    const sparse = new Array<unknown>(2)
    sparse[1] = "present"
    expect(() =>
      codexAgent({
        config: { sparse: sparse as never },
      })
    ).toThrow("Codex config.sparse cannot contain sparse arrays")
  })

  it("enforces the exact provider-configuration depth boundary", () => {
    let acceptedConfig: Record<string, unknown> = {
      leaf: true,
    }

    for (let depth = 0; depth < 128; depth += 1) {
      acceptedConfig = { nested: acceptedConfig }
    }

    expect(() =>
      codexAgent({
        config: acceptedConfig as never,
      })
    ).not.toThrow()

    expect(() =>
      codexAgent({
        config: { nested: acceptedConfig } as never,
      })
    ).toThrow("Codex config exceeds the maximum depth of 128")
  })

  it("captures accessor-backed options exactly once", async () => {
    const clientFactory = new RecordingClientFactory()
    let reasoningReads = 0
    let skipReads = 0
    const options = Object.defineProperties(
      { clientFactory },
      {
        reasoningEffort: {
          enumerable: true,
          get() {
            reasoningReads += 1
            return reasoningReads === 1 ? "high" : "invalid"
          },
        },
        skipGitRepoCheck: {
          enumerable: true,
          get() {
            skipReads += 1
            return skipReads === 1 ? true : "invalid"
          },
        },
      }
    ) as CodexAgentOptions
    const provider = codexAgent(options)

    await provider.run(createRequest(), createContext())

    expect(reasoningReads).toBe(1)
    expect(skipReads).toBe(1)
    expect(clientFactory.threadOptions[0]).toMatchObject({
      modelReasoningEffort: "high",
      skipGitRepoCheck: true,
    })
  })

  it("forwards cancellation to the active turn and stops later FollowUps", async () => {
    const clientFactory = new RecordingClientFactory()
    const controller = new AbortController()
    const cancelled = new Error("cancel codex")
    clientFactory.response = async (_prompt, options) =>
      await new Promise<CodexTurnResult>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
      })
    const provider = codexAgent({ clientFactory })
    const pending = provider.run(createRequest({ followUps: ["never"] }), createContext(controller.signal))

    await vi.waitFor(() => {
      expect(clientFactory.turns).toHaveLength(1)
    })
    controller.abort(cancelled)

    await expect(pending).rejects.toBe(cancelled)
    expect(clientFactory.turns).toHaveLength(1)
  })

  it("rejects cancellation triggered while reading an injected turn result", async () => {
    const clientFactory = new RecordingClientFactory()
    const controller = new AbortController()
    const cancelled = new Error("cancel from result getter")
    clientFactory.response = async () => {
      const result = {}

      Object.defineProperty(result, "finalResponse", {
        get() {
          controller.abort(cancelled)
          return "must not escape"
        },
      })

      return result as CodexTurnResult
    }
    const provider = codexAgent({ clientFactory })

    await expect(provider.run(createRequest(), createContext(controller.signal))).rejects.toBe(cancelled)
  })

  it("does not claim compatibility with AML Sandbox leases", () => {
    const provider = codexAgent({
      clientFactory: new RecordingClientFactory(),
    })

    expect(provider.supportsSandbox).toBeUndefined()
  })
})
