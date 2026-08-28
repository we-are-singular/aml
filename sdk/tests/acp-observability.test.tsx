import {
  agent,
  methods,
  ndJsonStream,
  type ActiveSession,
  type ActiveSessionMessage,
  type PromptResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk"
import { z } from "zod"
import { describe, expect, it } from "vitest"

import { AbstractAgentProvider } from "../src/components/agent/abstract-agent-provider.js"
import { defineAcpAgentProvider } from "../src/components/agent/acp-agent-provider.js"
import { openAcpSession, runAcpPrompt, runAcpPromptResponse } from "../src/components/agent/acp-agent-session.js"
import type { AgentExecutionContext } from "../src/components/agent/agent-execution-context.js"
import { agentObservabilityServices } from "../src/components/agent/agent-observability-services.js"
import type { AgentProviderSession, AgentProviderTurn } from "../src/components/agent/agent-provider-session.js"
import type { AgentRequest } from "../src/components/agent/agent-request.js"
import { agentStructuredOutputServices } from "../src/components/agent/agent-structured-output-services.js"
import { Agent } from "../src/components/agent/agent.js"
import { FollowUp } from "../src/components/follow-up/follow-up.js"
import { Sandbox } from "../src/components/sandbox/sandbox.js"
import type { SandboxProcess } from "../src/components/sandbox/sandbox-runtime.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { evaluate } from "../src/core/evaluate.js"
import { createConsoleTracer } from "../src/observability/create-console-tracer.js"
import type { AmlTraceEvent } from "../src/observability/trace-event.js"
import type { TraceSink } from "../src/observability/trace-sink.js"
import { createAgentExecutionContext } from "../src/testing/create-agent-execution-context.js"
import { DeterministicSandboxProvider } from "../src/testing/deterministic-sandbox-provider.js"

describe("ACP Agent response messages", () => {
  it("groups chunks into assistant messages with the final message last", async () => {
    const selected = script(
      [
        update({
          content: { text: "Working", type: "text" },
          messageId: "progress",
          sessionUpdate: "agent_message_chunk",
        }),
        update({
          content: { text: " on it.", type: "text" },
          messageId: "progress",
          sessionUpdate: "agent_message_chunk",
        }),
        update({
          content: { text: "Final answer.", type: "text" },
          messageId: "answer",
          sessionUpdate: "agent_message_chunk",
        }),
      ],
      { stopReason: "end_turn" }
    )

    await expect(
      runAcpPromptResponse(activeSession(selected), "prompt", createAgentExecutionContext())
    ).resolves.toEqual({
      messages: ["Working on it.", "Final answer."],
      text: "Working on it.Final answer.",
    })
  })

  it("preserves concatenated text without guessing mixed or legacy boundaries", async () => {
    const selected = script(
      [
        update({
          content: { text: "bounded", type: "text" },
          messageId: "message-1",
          sessionUpdate: "agent_message_chunk",
        }),
        update({
          content: { text: " legacy", type: "text" },
          sessionUpdate: "agent_message_chunk",
        }),
      ],
      { stopReason: "end_turn" }
    )

    await expect(
      runAcpPromptResponse(activeSession(selected), "prompt", createAgentExecutionContext())
    ).resolves.toEqual({ text: "bounded legacy" })
  })
})

describe("ACP Agent observability", () => {
  it("preserves unnamed Agent session and terminal attribute shapes", async () => {
    const events: AmlTraceEvent[] = []
    const provider = new ScriptedAcpProvider([script([], { stopReason: "end_turn" })])

    await new AmlRuntime({ trace: event => events.push(event) }).evaluate(<Agent provider={provider}>prompt</Agent>)

    const agentEnd = events.find(event => event.type === "span.end" && event.name === "Agent")
    const sessionStart = events.find(event => event.type === "span.start" && event.name === "agent.session")

    expect(sessionStart?.attributes).toEqual({ provider: "scripted-acp" })
    expect(agentEnd?.attributes).toEqual({
      mcpServers: 0,
      provider: "scripted-acp",
      tools: 0,
      turns: 1,
    })
  })

  it("traces actual two-turn lifecycle order around streamed ACP updates", async () => {
    const events: AmlTraceEvent[] = []
    const provider = new ScriptedAcpProvider([
      script(
        [
          update({
            content: { text: "first response", type: "text" },
            sessionUpdate: "agent_message_chunk",
          }),
          update({
            kind: "read",
            sessionUpdate: "tool_call",
            status: "in_progress",
            title: "Read private file",
            toolCallId: "tool-1",
          }),
          update({
            sessionUpdate: "tool_call_update",
            status: "completed",
            toolCallId: "tool-1",
          }),
        ],
        { stopReason: "end_turn" }
      ),
      script(
        [
          update({
            content: { text: "second response", type: "text" },
            sessionUpdate: "agent_message_chunk",
          }),
        ],
        {
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        }
      ),
    ])

    await expect(
      new AmlRuntime({ trace: event => events.push(event) }).evaluate(
        <Agent name="researcher" provider={provider}>
          first prompt
          <FollowUp>second prompt</FollowUp>
        </Agent>
      )
    ).resolves.toBe("second response")

    const turns = events.filter(event => event.type !== "event" && event.name === "agent.turn")
    expect(turns).toMatchObject([
      { attributes: { index: 1, kind: "initial" }, type: "span.start" },
      { attributes: { stopReason: "end_turn" }, status: "ok", type: "span.end" },
      { attributes: { index: 2, kind: "follow-up" }, type: "span.start" },
      {
        attributes: {
          stopReason: "end_turn",
          usage: '{"inputTokens":10,"outputTokens":4,"totalTokens":14}',
        },
        status: "ok",
        type: "span.end",
      },
    ])

    const firstTurnEnd = turns[1]
    const secondTurnStart = turns[2]
    expect(firstTurnEnd?.sequence).toBeLessThan(secondTurnStart?.sequence ?? 0)
    expect(
      events.find(
        event =>
          event.type === "event" &&
          event.name === "acp.session.update" &&
          event.attributes.sessionUpdate === "tool_call"
      )
    ).toMatchObject({
      attributes: {
        sessionId: "session-test",
        sessionUpdate: "tool_call",
      },
    })
    expect(
      events.find(
        event =>
          event.type === "event" &&
          event.name === "acp.session.update" &&
          event.attributes.sessionUpdate === "tool_call_update"
      )
    ).toMatchObject({
      attributes: {
        sessionId: "session-test",
        sessionUpdate: "tool_call_update",
      },
    })

    const agentEnd = events.find(event => event.type === "span.end" && event.name === "Agent")
    const sessionStart = events.find(event => event.type === "span.start" && event.name === "agent.session")
    const cleanupStart = events.find(event => event.type === "span.start" && event.name === "agent.cleanup")
    expect(agentEnd).toMatchObject({ attributes: { name: "researcher", provider: "scripted-acp" } })
    expect(sessionStart).toMatchObject({ attributes: { name: "researcher", provider: "scripted-acp" } })
    expect(turns[0]).toMatchObject({ parentSpanId: sessionStart?.spanId })
    expect(cleanupStart).toMatchObject({ parentSpanId: sessionStart?.spanId })
  })

  it("publishes progress before a slow ACP turn completes", async () => {
    const events: AmlTraceEvent[] = []
    let releaseUpdate: (() => void) | undefined
    let markWaiting: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      releaseUpdate = resolve
    })
    const waiting = new Promise<void>(resolve => {
      markWaiting = resolve
    })
    const provider = new ScriptedAcpProvider([
      script(
        [
          async () => {
            markWaiting?.()
            await gate
            return update({
              content: { text: "eventually", type: "text" },
              sessionUpdate: "agent_message_chunk",
            })
          },
        ],
        { stopReason: "end_turn" }
      ),
    ])
    const pending = new AmlRuntime({ trace: event => events.push(event) }).evaluate(
      <Agent provider={provider}>slow prompt</Agent>
    )

    await waiting
    expect(events.some(event => event.type === "event" && event.name === "acp.session.prompt.submitted")).toBe(true)
    expect(events.some(event => event.type === "span.end" && event.name === "agent.turn")).toBe(false)

    releaseUpdate?.()
    await expect(pending).resolves.toBe("eventually")
    expect(
      events.some(
        event =>
          event.type === "event" &&
          event.name === "acp.session.update" &&
          event.attributes.sessionUpdate === "agent_message_chunk"
      )
    ).toBe(true)
  })

  it("redacts ACP content by default and exposes supported content only after opt-in", async () => {
    const hidden = await captureContent(false)
    const visible = await captureContent(true)

    for (const secret of [
      "PRIVATE_PROMPT",
      "PRIVATE_MESSAGE",
      "PRIVATE_THOUGHT",
      "PRIVATE_TOOL_TITLE",
      "PRIVATE_TOOL_INPUT",
      "PRIVATE_PLAN",
    ]) {
      expect(JSON.stringify(hidden)).not.toContain(secret)
      expect(JSON.stringify(visible)).toContain(secret)
    }

    const hiddenTool = hidden.find(
      event =>
        event.type === "event" && event.name === "acp.session.update" && event.attributes.sessionUpdate === "tool_call"
    )
    expect(hiddenTool).toMatchObject({
      attributes: {
        sessionId: "session-test",
        sessionUpdate: "tool_call",
      },
    })
    expect(hiddenTool?.attributes).not.toHaveProperty("update")

    const visibleTool = visible.find(
      event =>
        event.type === "event" && event.name === "acp.session.update" && event.attributes.sessionUpdate === "tool_call"
    )
    expect(JSON.parse(String(visibleTool?.attributes.update))).toEqual({
      kind: "execute",
      name: "shell",
      rawInput: { command: "PRIVATE_TOOL_INPUT" },
      sessionUpdate: "tool_call",
      status: "pending",
      title: "PRIVATE_TOOL_TITLE",
      toolCallId: "tool-private",
    })
  })

  it("traces a no-update provider turn through prompt, completion, and cleanup", async () => {
    const events: AmlTraceEvent[] = []
    const provider = new ScriptedAcpProvider([script([], { stopReason: "end_turn" })])

    await expect(
      new AmlRuntime({ trace: event => events.push(event) }).evaluate(<Agent provider={provider}>quiet</Agent>)
    ).resolves.toBe("")

    expect(events.filter(event => event.type === "event").map(event => event.name)).toContain(
      "acp.session.prompt.submitted"
    )
    expect(events.find(event => event.type === "event" && event.name === "acp.session.prompt.completed")).toMatchObject(
      {
        attributes: { sessionId: "session-test", stopReason: "end_turn" },
      }
    )
    expect(events.find(event => event.type === "span.end" && event.name === "agent.cleanup")).toMatchObject({
      status: "ok",
    })
  })

  it("orders structured-result submission inside the final turn and captures its value only after opt-in", async () => {
    const hidden = await captureStructuredOutput(false)
    const visible = await captureStructuredOutput(true)
    const output = visible.find(event => event.type === "event" && event.name === "agent.output")
    const finalTurn = visible.find(
      event => event.type === "span.start" && event.name === "agent.turn" && event.attributes.kind === "follow-up"
    )

    expect(output).toMatchObject({
      attributes: { call: 1, output: '{"proof":"PRIVATE_STRUCTURED"}', status: "accepted" },
      spanId: finalTurn?.spanId,
    })
    expect(JSON.stringify(hidden)).not.toContain("PRIVATE_STRUCTURED")
  })

  it("traces cancellation, failed turn completion, and cleanup in lifecycle order", async () => {
    const events: AmlTraceEvent[] = []
    const controller = new AbortController()
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    const provider = new (class extends AbstractAgentProvider<"cancel-acp"> {
      constructor() {
        super("cancel-acp")
      }

      protected async openSession(
        _request: AgentRequest,
        _context: AgentExecutionContext
      ): Promise<AgentProviderSession> {
        return {
          async abort() {},
          async close() {},
          async runTurn(_turn, context) {
            markStarted?.()
            return await new Promise<never>((_resolve, reject) => {
              context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true })
            })
          },
        }
      }
    })()
    const pending = new AmlRuntime({ trace: event => events.push(event) }).evaluate(
      <Agent provider={provider}>cancel me</Agent>,
      { signal: controller.signal }
    )
    await started
    const cancellation = new Error("cancelled by test")
    controller.abort(cancellation)

    await expect(pending).rejects.toMatchObject({ cause: cancellation })
    const cancellationEvent = events.find(
      event =>
        event.type === "event" && event.name === "agent.session" && event.attributes.state === "cancellation_requested"
    )
    const turnEnd = events.find(event => event.type === "span.end" && event.name === "agent.turn")
    const cleanupEnd = events.find(event => event.type === "span.end" && event.name === "agent.cleanup")
    expect(cancellationEvent).toBeDefined()
    expect(turnEnd).toMatchObject({ status: "error" })
    expect(cleanupEnd).toMatchObject({ status: "ok" })
    expect(cancellationEvent?.sequence).toBeLessThan(turnEnd?.sequence ?? 0)
    expect(turnEnd?.sequence).toBeLessThan(cleanupEnd?.sequence ?? 0)
  })

  it("terminates a process when cancellation reaches ACP session setup", async () => {
    const cancellation = new Error("cancelled before ACP setup")
    const controller = new AbortController()
    const calls: string[] = []
    const process: SandboxProcess = {
      id: "remote-process",
      async kill() {
        calls.push("kill")
      },
      stdin: new WritableStream(),
      stderr: emptyStream(),
      stdout: emptyStream(),
      async wait() {
        calls.push("wait")
        return { exitCode: 137 }
      },
    }
    const context = createAgentExecutionContext({ signal: controller.signal })
    controller.abort(cancellation)

    await expect(
      openAcpSession({
        cwd: "/workspace",
        observability: agentObservabilityServices(context),
        process,
        signal: controller.signal,
      })
    ).rejects.toBe(cancellation)
    expect(calls).toEqual(["kill", "wait"])
  })

  it("traces an unexpected process wait failure without claiming an exit", async () => {
    const events: AmlTraceEvent[] = []
    const processError = new Error("remote wait failed")
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: command => ({ exitCode: 0, stderr: "", stdout: command === "pwd" ? "/workspace\n" : "" }),
      spawn: () => processWithFailedWait(processError),
    })
    const provider = defineAcpAgentProvider({
      createLaunch: () => ({ command: "fixture-acp", permissionPolicy: "reject_once" }),
      name: "fixture-acp",
      workingDirectory: undefined,
    })

    await expect(
      new AmlRuntime({ agentProvider: provider, trace: event => events.push(event) }).evaluate(
        <Sandbox access="read-write" provider={sandboxProvider}>
          <Agent>Prompt</Agent>
        </Sandbox>
      )
    ).rejects.toMatchObject({ cause: processError })

    expect(
      events.filter(event => event.type === "event" && event.name === "sandbox.process").map(event => event.attributes)
    ).toEqual([
      { state: "spawn_requested" },
      { "execution.id": "remote-process", state: "started" },
      { "execution.id": "remote-process", state: "wait_failed" },
      { "execution.id": "remote-process", state: "kill_requested" },
      { "execution.id": "remote-process", state: "kill_completed" },
    ])
  })

  it("renders qualified Agent lifecycle names without repeating the span kind", async () => {
    const lines: string[] = []
    const provider = new ScriptedAcpProvider([script([], { stopReason: "end_turn" })])

    await new AmlRuntime({
      trace: createConsoleTracer({ write: line => lines.push(line) }),
    }).evaluate(<Agent provider={provider}>quiet</Agent>)

    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("▶ agent.session"),
        expect.stringContaining("▶ agent.turn"),
        expect.stringContaining("▶ agent.cleanup"),
      ])
    )
    expect(lines.join("\n")).not.toContain("agent agent.")
  })

  it("keeps streamed ACP updates in traces while suppressing repetitive console lines", async () => {
    const events: AmlTraceEvent[] = []
    const lines: string[] = []
    const provider = new ScriptedAcpProvider([
      script(
        [
          update({
            content: { text: "done", type: "text" },
            sessionUpdate: "agent_message_chunk",
          }),
          update({
            content: { text: "thinking", type: "text" },
            sessionUpdate: "agent_thought_chunk",
          }),
          update({
            kind: "execute",
            name: "shell",
            sessionUpdate: "tool_call",
            status: "in_progress",
            title: "Run command",
            toolCallId: "tool-1",
          }),
          update({
            sessionUpdate: "tool_call_update",
            status: "completed",
            toolCallId: "tool-1",
          }),
        ],
        { stopReason: "end_turn" }
      ),
    ])
    const runtime = new AmlRuntime({
      trace: createConsoleTracer({ captureContent: true, write: line => lines.push(line) }),
    })
    runtime.on("trace", event => events.push(event))

    await runtime.evaluate(<Agent provider={provider}>work</Agent>)

    expect(
      events
        .filter(event => event.type === "event" && event.name === "acp.session.update")
        .map(event => event.attributes.sessionUpdate)
    ).toEqual(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"])

    const output = lines.join("\n")
    expect(output).toContain('sessionUpdate="tool_call" toolName="shell"')
    expect(output).not.toContain("agent_message_chunk")
    expect(output).not.toContain("agent_thought_chunk")
    expect(output).not.toContain("tool_call_update")
  })
})

class ScriptedAcpProvider extends AbstractAgentProvider<"scripted-acp"> {
  readonly #scripts: readonly TurnScript[]

  constructor(scripts: readonly TurnScript[]) {
    super("scripted-acp")
    this.#scripts = scripts
  }

  protected async openSession(_request: AgentRequest, _context: AgentExecutionContext): Promise<AgentProviderSession> {
    return {
      async close() {},
      runTurn: async (turn, context) => await this.#runTurn(turn, context),
    }
  }

  async #runTurn(turn: Readonly<AgentProviderTurn>, context: AgentExecutionContext) {
    const selected = this.#scripts[turn.index]
    if (selected === undefined) throw new Error(`Missing ACP script for turn ${turn.index}`)

    const text = await runAcpPrompt(activeSession(selected), turn.prompt, context)
    return { text }
  }
}

interface TurnScript {
  readonly response: PromptResponse
  readonly updates: readonly (ActiveSessionMessage | (() => Promise<ActiveSessionMessage>))[]
}

function script(
  updates: readonly (ActiveSessionMessage | (() => Promise<ActiveSessionMessage>))[],
  response: PromptResponse
): TurnScript {
  return { response, updates }
}

function activeSession(selected: TurnScript): Pick<ActiveSession, "nextUpdate" | "prompt" | "sessionId"> {
  let index = 0

  return {
    sessionId: "session-test",
    async nextUpdate() {
      const next = selected.updates[index++]
      if (next === undefined) {
        return { kind: "stop", response: selected.response, stopReason: selected.response.stopReason }
      }

      return typeof next === "function" ? await next() : next
    },
    async prompt() {
      return selected.response
    },
  }
}

function update(value: SessionUpdate): ActiveSessionMessage {
  return {
    kind: "session_update",
    notification: { sessionId: "session-test", update: value },
    update: value,
  }
}

async function captureContent(enabled: boolean): Promise<AmlTraceEvent[]> {
  const events: AmlTraceEvent[] = []
  const sink = ((event: AmlTraceEvent) => events.push(event)) as TraceSink
  Object.defineProperty(sink, "captureContent", { value: enabled })
  const provider = new ScriptedAcpProvider([
    script(
      [
        update({
          content: { text: "PRIVATE_MESSAGE", type: "text" },
          sessionUpdate: "agent_message_chunk",
        }),
        update({
          content: { text: "PRIVATE_THOUGHT", type: "text" },
          sessionUpdate: "agent_thought_chunk",
        }),
        update({
          kind: "execute",
          name: "shell",
          rawInput: { command: "PRIVATE_TOOL_INPUT" },
          sessionUpdate: "tool_call",
          status: "pending",
          title: "PRIVATE_TOOL_TITLE",
          toolCallId: "tool-private",
        }),
        update({
          entries: [{ content: "PRIVATE_PLAN", priority: "high", status: "in_progress" }],
          sessionUpdate: "plan",
        }),
      ],
      { stopReason: "end_turn" }
    ),
  ])

  await new AmlRuntime({ trace: sink }).evaluate(<Agent provider={provider}>PRIVATE_PROMPT</Agent>)
  return events
}

async function captureStructuredOutput(enabled: boolean): Promise<AmlTraceEvent[]> {
  const events: AmlTraceEvent[] = []
  const sink = ((event: AmlTraceEvent) => events.push(event)) as TraceSink
  Object.defineProperty(sink, "captureContent", { value: enabled })
  const value = { proof: "PRIVATE_STRUCTURED" }
  const provider = new (class extends AbstractAgentProvider<"structured-acp"> {
    constructor() {
      super("structured-acp")
    }

    protected async openSession(_request: AgentRequest, context: AgentExecutionContext): Promise<AgentProviderSession> {
      const output = agentStructuredOutputServices(context)
      return {
        async close() {},
        async runTurn(turn) {
          if (turn.output !== undefined) output.traceSubmission(1, "accepted", value)
          return turn.output === undefined ? { text: "continue" } : { structured: value, text: "" }
        },
      }
    }
  })()

  async function Workflow() {
    const result = await evaluate(
      <Agent provider={provider}>
        inspect
        <FollowUp>submit</FollowUp>
      </Agent>,
      z.object({ proof: z.string() })
    )
    return result.proof
  }

  await expect(new AmlRuntime({ trace: sink }).evaluate(<Workflow />)).resolves.toBe("PRIVATE_STRUCTURED")
  return events
}

function processWithFailedWait(error: Error): Readonly<SandboxProcess> {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  let rejectWait: (reason: Error) => void = () => undefined
  const wait = new Promise<never>((_resolve, reject) => {
    rejectWait = reject
  })
  const app = agent({ name: "fixture-acp" })
    .onRequest(methods.agent.initialize, ({ params }) => ({
      protocolVersion: params.protocolVersion,
    }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: "fixture-session" }))
    .onRequest(methods.agent.session.prompt, async () => {
      rejectWait(error)
      return await new Promise<never>(() => undefined)
    })
  const connection = app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable))

  return Object.freeze({
    id: "remote-process",
    async kill() {
      connection.close()
    },
    stdin: clientToAgent.writable,
    stderr: emptyStream(),
    stdout: agentToClient.readable,
    wait: async () => await wait,
  })
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: controller => controller.close() })
}
