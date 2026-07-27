import type {
  AgentExecutionContext,
  AgentRequest,
  AgentResponse,
} from "@aml/sdk"
import { Agent, AmlRuntime } from "@aml/sdk"
import { agentProviderConformance } from "@aml/sdk/testing"
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
} from "../src/index.js"
import { OpenCodeSdkClient } from "../src/opencode-sdk-client.js"
import { OpenCodeSession } from "../src/opencode-session.js"

class RecordingSessionClient implements OpenCodeSessionClient {
  readonly abortCalls: OpenCodeSessionLocation[] = []
  readonly createCalls: {
    input: OpenCodeSessionCreateInput
    signal: AbortSignal
  }[] = []
  readonly deleteCalls: OpenCodeSessionLocation[] = []
  readonly promptCalls: {
    input: OpenCodeSessionPromptInput
    signal: AbortSignal
  }[] = []
  promptResult: OpenCodeSessionPromptResult = {
    parts: [{ text: "response", type: "text" }],
  }

  async create(
    input: OpenCodeSessionCreateInput,
    signal: AbortSignal,
  ): Promise<string> {
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

  async abort(input: OpenCodeSessionLocation): Promise<void> {
    this.abortCalls.push(input)
  }

  async delete(input: OpenCodeSessionLocation): Promise<void> {
    this.deleteCalls.push(input)
  }
}

function createRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return Object.freeze({
    prompt: "prompt",
    system: "system",
    ...overrides,
  })
}

function createContext(signal = new AbortController().signal) {
  const trace = Object.freeze({ runId: "run", spanId: "span-1" })
  return Object.freeze({ signal, trace }) satisfies AgentExecutionContext
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
})

describe("OpenCodeSdkClient", () => {
  it("maps the AML session port to the generated v2 SDK", async () => {
    const signal = new AbortController().signal
    const textPart = { text: "response", type: "text" }
    const rawClient = {
      session: {
        abort: vi.fn(async () => ({ data: true })),
        create: vi.fn(async () => ({ data: { id: "session-id" } })),
        delete: vi.fn(async () => ({ data: true })),
        prompt: vi.fn(async () => ({
          data: { info: { error: undefined }, parts: [textPart] },
        })),
      },
    }
    const client = new OpenCodeSdkClient(rawClient as never)
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
          prompt: "prompt",
          sessionId: "session-id",
          system: "system",
          tools: { "*": false },
        },
        signal,
      ),
    ).resolves.toEqual({ parts: [textPart] })
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
    const client = new OpenCodeSdkClient(rawClient as never)
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
    const client = new OpenCodeSdkClient(rawClient as never)

    await expect(client.abort({ sessionId: "session-id" })).rejects.toThrow(
      "OpenCode did not abort session session-id",
    )
    await expect(client.delete({ sessionId: "session-id" })).rejects.toThrow(
      "OpenCode did not delete session session-id",
    )
  })
})
