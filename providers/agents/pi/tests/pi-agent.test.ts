import type { AgentRequest } from "@aml-jsx/sdk"
import { agentProviderConformance, createAgentExecutionContext } from "@aml-jsx/sdk/testing"
import { describe, expect, it, vi } from "vitest"

import { piAgent, type PiSessionClient, type PiSessionClientFactory, type PiSessionCreateInput } from "../src/index.js"

class RecordingSessionFactory implements PiSessionClientFactory {
  readonly inputs: PiSessionCreateInput[] = []
  readonly prompts: string[][] = []
  readonly outputSchemas: (Readonly<Record<string, unknown>> | undefined)[][] = []
  aborts = 0
  disposals = 0
  response: (prompt: string) => Promise<string> = async prompt => `response:${prompt}`

  async create(input: PiSessionCreateInput): Promise<PiSessionClient> {
    const prompts: string[] = []
    const outputSchemas: (Readonly<Record<string, unknown>> | undefined)[] = []
    this.inputs.push(input)
    this.prompts.push(prompts)
    this.outputSchemas.push(outputSchemas)

    return {
      abort: async () => {
        this.aborts += 1
      },
      dispose: () => {
        this.disposals += 1
      },
      prompt: async (prompt, outputSchema) => {
        prompts.push(prompt)
        outputSchemas.push(outputSchema)
        return await this.response(prompt)
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

function createContext(signal = new AbortController().signal) {
  return createAgentExecutionContext({
    signal,
    trace: {
      runId: "run",
      spanId: "span-1",
    },
  })
}

describe("piAgent", () => {
  it("is lazy, immutable, and SDK-conformant", async () => {
    const clientFactory = new RecordingSessionFactory()
    const providers = { "opencode-go": { apiKey: "secret", headers: { "x-proof": "original" } } }
    const provider = piAgent({
      clientFactory,
      model: "opencode-go/minimax-m3",
      providers,
      thinkingLevel: "high",
      workingDirectory: "/workspace",
    })
    providers["opencode-go"].apiKey = "changed"
    providers["opencode-go"].headers["x-proof"] = "changed"

    expect(clientFactory.inputs).toHaveLength(0)
    expect(Object.isFrozen(provider)).toBe(true)
    expect(provider.name).toBe("pi")

    await expect(agentProviderConformance(provider)).resolves.toBeUndefined()

    expect(clientFactory.inputs).toHaveLength(1)
    expect(clientFactory.inputs[0]).toMatchObject({
      cwd: "/workspace",
      model: "opencode-go/minimax-m3",
      providers: { "opencode-go": { apiKey: "secret", headers: { "x-proof": "original" } } },
      system: "Follow the provider contract.",
      thinkingLevel: "high",
      tools: [],
    })
    expect(clientFactory.prompts).toEqual([["agent-provider-conformance", "agent-provider-conformance-final"]])
    expect(clientFactory.disposals).toBe(1)
  })

  it("applies the per-Agent model and returns final FollowUp output", async () => {
    const clientFactory = new RecordingSessionFactory()
    const provider = piAgent({
      clientFactory,
      model: "opencode-go/minimax-m3",
    })
    const response = await provider.run(
      createRequest({
        followUps: ["second", "final"],
        model: "opencode-go/glm-5.1",
      }),
      createContext()
    )

    expect(response).toEqual({ text: "response:final" })
    expect(clientFactory.inputs[0]?.model).toBe("opencode-go/glm-5.1")
    expect(clientFactory.prompts[0]).toEqual(["prompt", "second", "final"])
  })

  it("translates exact host and JavaScript Tool grants", async () => {
    const clientFactory = new RecordingSessionFactory()
    const execute = vi.fn(async () => "value")
    const provider = piAgent({ clientFactory })

    await provider.run(
      createRequest({
        tools: [
          { kind: "host", name: "read" },
          {
            description: "Lookup a value",
            execute,
            inputSchema: {
              additionalProperties: false,
              properties: {},
              type: "object",
            },
            kind: "javascript",
            name: "lookup",
          },
        ],
      }),
      createContext()
    )

    expect(clientFactory.inputs[0]?.tools).toEqual([
      "read",
      expect.objectContaining({
        description: "Lookup a value",
        name: "lookup",
      }),
    ])
  })

  it("parses structured JSON for AML validation", async () => {
    const clientFactory = new RecordingSessionFactory()
    clientFactory.response = async () => '{"count":3}'
    const provider = piAgent({ clientFactory })
    const response = await provider.run(
      createRequest({
        output: {
          jsonSchema: {
            additionalProperties: false,
            properties: { count: { type: "number" } },
            required: ["count"],
            type: "object",
          },
          type: "json",
        },
      }),
      createContext()
    )

    expect(response).toEqual({
      structured: { count: 3 },
      text: '{"count":3}',
    })
    expect(clientFactory.outputSchemas[0]?.[0]).toMatchObject({
      properties: { count: { type: "number" } },
    })
  })

  it("rejects unsupported host Tools and MCP before session creation", async () => {
    const clientFactory = new RecordingSessionFactory()
    const provider = piAgent({ clientFactory })

    await expect(
      provider.run(
        createRequest({
          tools: [{ kind: "host", name: "web_search" }],
        }),
        createContext()
      )
    ).rejects.toThrow('Pi host Tool "web_search" is unsupported')

    await expect(
      provider.run(
        createRequest({
          mcpServers: [{ kind: "named", name: "project" }],
        }),
        createContext()
      )
    ).rejects.toThrow("Pi Agent does not yet support AML MCP servers")
    expect(clientFactory.inputs).toHaveLength(0)
  })

  it("aborts the Pi session when AML cancellation arrives", async () => {
    const controller = new AbortController()
    const clientFactory = new RecordingSessionFactory()
    let release: (() => void) | undefined
    clientFactory.response = async () =>
      await new Promise<string>(resolve => {
        release = () => resolve("late")
      })
    const provider = piAgent({ clientFactory })
    const execution = provider.run(createRequest(), createContext(controller.signal))
    const rejection = expect(execution).rejects.toThrow("cancel Pi")

    await vi.waitFor(() => expect(clientFactory.prompts[0]).toEqual(["prompt"]))
    controller.abort(new Error("cancel Pi"))
    await vi.waitFor(() => expect(clientFactory.aborts).toBe(1))
    release?.()

    await rejection
    expect(clientFactory.disposals).toBe(1)
  })

  it("validates configuration without constructing Pi", () => {
    expect(() => piAgent(null as never)).toThrow("Pi Agent options must be an object")
    expect(() => piAgent({ model: " opencode-go/minimax-m3" })).toThrow(
      "Pi model must be a non-empty normalized string"
    )
    expect(() => piAgent({ thinkingLevel: "extreme" as never })).toThrow("Pi thinkingLevel is unsupported")
    expect(() => piAgent({ clientFactory: {} as never })).toThrow("Pi clientFactory create must be a function")
  })
})
