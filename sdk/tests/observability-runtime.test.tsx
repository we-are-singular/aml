import { z } from "zod"
import { describe, expect, it, vi } from "vitest"

import { Agent } from "../src/components/agent/agent.js"
import { FollowUp } from "../src/components/follow-up/follow-up.js"
import { Loop } from "../src/components/loop/loop.js"
import { defineMcpServer } from "../src/components/mcp/define-mcp-server.js"
import { Mcp } from "../src/components/mcp/mcp.js"
import { Sandbox } from "../src/components/sandbox/sandbox.js"
import { Skill } from "../src/components/skill/skill.js"
import { System } from "../src/components/system/system.js"
import { defineTool } from "../src/components/tool/define-tool.js"
import { Tool } from "../src/components/tool/tool.js"
import { Workspace } from "../src/components/workspace/workspace.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { evaluate } from "../src/core/evaluate.js"
import { createConsoleTracer } from "../src/observability/create-console-tracer.js"
import type { AmlTraceEvent } from "../src/observability/trace-event.js"
import type { TraceSink } from "../src/observability/trace-sink.js"
import { DeterministicAgentProvider } from "../src/testing/deterministic-agent-provider.js"
import { DeterministicSandboxProvider } from "../src/testing/deterministic-sandbox-provider.js"
import { DeterministicWorkspaceProvider } from "../src/testing/deterministic-workspace-provider.js"

describe("observability", () => {
  it("publishes attributable immutable spans without content by default", async () => {
    const events: AmlTraceEvent[] = []
    const lookup = defineTool({
      description: "Look up one record",
      input: z.object({ id: z.number() }),
      name: "lookup",
      execute: ({ id }) => ({ id, status: "active" }),
    })
    const provider = new DeterministicAgentProvider({
      async respond(request, context) {
        const tool = request.tools.find(
          (candidate) => candidate.name === "lookup",
        )

        if (tool?.kind !== "javascript") {
          throw new Error("Expected lookup Tool")
        }

        await expect(
          tool.execute(
            { id: 42 },
            {
              signal: context.signal,
              trace: context.trace,
            },
          ),
        ).resolves.toEqual({ id: 42, status: "active" })

        return { text: "PRIVATE_OUTPUT" }
      },
    })

    function Review() {
      return (
        <Agent provider={provider}>
          <System>PRIVATE_SYSTEM</System>
          <Skill
            description="PRIVATE_DESCRIPTION"
            name="evidence"
          >
            PRIVATE_SKILL
          </Skill>
          <Tool use={lookup} />
          <Mcp name="project" />
          PRIVATE_PROMPT
          <FollowUp>PRIVATE_FOLLOW_UP</FollowUp>
        </Agent>
      )
    }

    await expect(
      new AmlRuntime({
        allowedMcpServers: ["project"],
        trace(event) {
          events.push(event)
        },
      }).evaluate(<Review />),
    ).resolves.toBe("PRIVATE_OUTPUT")

    expect(events.length).toBeGreaterThan(10)
    expect(events.map(({ sequence }) => sequence)).toEqual(
      events.map((_event, index) => index + 1),
    )

    for (const event of events) {
      expect(Object.isFrozen(event)).toBe(true)
      expect(Object.isFrozen(event.attributes)).toBe(true)
    }

    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain("PRIVATE_SYSTEM")
    expect(serialized).not.toContain("PRIVATE_SKILL")
    expect(serialized).not.toContain("PRIVATE_DESCRIPTION")
    expect(serialized).not.toContain("PRIVATE_PROMPT")
    expect(serialized).not.toContain("PRIVATE_FOLLOW_UP")
    expect(serialized).not.toContain("PRIVATE_OUTPUT")

    const rootStart = events.find(
      (event) =>
        event.type === "span.start" &&
        event.kind === "evaluation",
    )
    const rootEnd = events.find(
      (event) =>
        event.type === "span.end" &&
        event.kind === "evaluation",
    )
    const agentStart = events.find(
      (event) =>
        event.type === "span.start" &&
        event.kind === "agent",
    )
    const agentEnd = events.find(
      (event) =>
        event.type === "span.end" &&
        event.kind === "agent",
    )
    const toolStart = events.find(
      (event) =>
        event.type === "span.start" &&
        event.kind === "tool",
    )
    const componentStart = events.find(
      (event) =>
        event.type === "span.start" &&
        event.kind === "component" &&
        event.name === "Review",
    )
    const skillStart = events.find(
      (event) =>
        event.type === "span.start" &&
        event.kind === "skill",
    )
    const systemStart = events.find(
      (event) =>
        event.type === "span.start" &&
        event.kind === "system",
    )

    expect(rootStart).toMatchObject({
      name: "evaluate",
      spanId: "trace-0",
    })
    expect(rootStart).not.toHaveProperty("parentSpanId")
    expect(rootEnd).toMatchObject({
      spanId: rootStart?.spanId,
      status: "ok",
    })
    expect(componentStart).toMatchObject({
      parentSpanId: rootStart?.spanId,
    })
    expect(agentStart).toMatchObject({
      name: "Agent",
      parentSpanId: componentStart?.spanId,
      spanId: "span-1",
    })
    expect(agentEnd).toMatchObject({
      attributes: {
        mcpServers: 1,
        provider: "deterministic",
        tools: 1,
        turns: 2,
      },
      spanId: agentStart?.spanId,
      status: "ok",
    })
    expect(toolStart).toMatchObject({
      name: "lookup",
      parentSpanId: agentStart?.spanId,
    })
    expect(skillStart).toMatchObject({
      parentSpanId: agentStart?.spanId,
    })
    expect(systemStart).toMatchObject({
      parentSpanId: agentStart?.spanId,
    })
    expect(
      events.filter(
        (event) =>
          event.type === "event" &&
          event.name === "agent.turn",
      ),
    ).toMatchObject([
      { attributes: { index: 1, kind: "initial" } },
      { attributes: { index: 2, kind: "follow-up" } },
    ])
    expect(
      events.find(
        (event) =>
          event.type === "event" &&
          event.name === "capability.tool",
      ),
    ).toMatchObject({
      attributes: { kind: "javascript", name: "lookup" },
      spanId: agentStart?.spanId,
    })
    expect(
      events.find(
        (event) =>
          event.type === "event" &&
          event.name === "capability.mcp",
      ),
    ).toMatchObject({
      attributes: { kind: "named", name: "project" },
      spanId: agentStart?.spanId,
    })

    const starts = events.filter(
      (event) => event.type === "span.start",
    )

    for (const start of starts) {
      expect(
        events.some(
          (event) =>
            event.type === "span.end" &&
            event.spanId === start.spanId &&
            event.kind === start.kind,
        ),
      ).toBe(true)
    }
  })

  it("captures runtime-owned content only after explicit sink opt-in", async () => {
    const events: AmlTraceEvent[] = []
    let captureReads = 0
    const sink = ((event: AmlTraceEvent) => {
      events.push(event)
    }) as TraceSink

    Object.defineProperty(sink, "captureContent", {
      get() {
        captureReads += 1
        return true
      },
    })

    const runtime = new AmlRuntime({
      agentProvider: new DeterministicAgentProvider({
        respond: () => ({ text: "VISIBLE_OUTPUT" }),
      }),
      trace: sink,
    })

    await runtime.evaluate(
      <Agent system="VISIBLE_SYSTEM">VISIBLE_PROMPT</Agent>,
    )
    await runtime.evaluate("plain")

    const agentEnd = events.find(
      (event) =>
        event.type === "span.end" &&
        event.kind === "agent",
    )

    expect(agentEnd?.attributes).toMatchObject({
      output: "VISIBLE_OUTPUT",
      prompt: "VISIBLE_PROMPT",
      system: "VISIBLE_SYSTEM",
    })
    expect(captureReads).toBe(1)
  })

  it("applies content consent independently to runtime trace listeners", async () => {
    const redactedEvents: AmlTraceEvent[] = []
    const visibleLines: string[] = []
    const runtime = new AmlRuntime({
      agentProvider: new DeterministicAgentProvider({
        respond: () => ({ text: "PRIVATE_OUTPUT" }),
      }),
    })

    runtime.on("trace", (event) => redactedEvents.push(event))
    runtime.on(
      "trace",
      createConsoleTracer({
        captureContent: true,
        write: (line) => visibleLines.push(line),
      }),
    )

    await runtime.evaluate(
      <Agent system="PRIVATE_SYSTEM">PRIVATE_PROMPT</Agent>,
    )

    const visible = visibleLines.join("\n")
    const redacted = JSON.stringify(redactedEvents)

    expect(visible).toContain("PRIVATE_PROMPT")
    expect(visible).toContain("PRIVATE_OUTPUT")
    expect(redacted).not.toContain("PRIVATE_PROMPT")
    expect(redacted).not.toContain("PRIVATE_SYSTEM")
    expect(redacted).not.toContain("PRIVATE_OUTPUT")
  })

  it("captures Tool input and output only after explicit content opt-in", async () => {
    const hiddenEvents: AmlTraceEvent[] = []
    const visibleEvents: AmlTraceEvent[] = []
    const tool = defineTool({
      description: "Echo trace content",
      input: z.object({ secret: z.string() }),
      name: "trace_echo",
      execute: ({ secret }) => ({ echoed: secret }),
    })
    const provider = new DeterministicAgentProvider({
      async respond(request, context) {
        const callable = request.tools.find(
          (candidate) => candidate.name === "trace_echo",
        )

        if (callable?.kind !== "javascript") {
          throw new Error("Expected trace_echo Tool")
        }

        await callable.execute(
          { secret: "TOOL_SECRET" },
          {
            signal: context.signal,
            trace: context.trace,
          },
        )
        return { text: "done" }
      },
    })
    const visibleSink = ((event: AmlTraceEvent) => {
      visibleEvents.push(event)
    }) as TraceSink

    Object.defineProperty(visibleSink, "captureContent", {
      value: true,
    })

    await new AmlRuntime({
      trace: (event) => hiddenEvents.push(event),
    }).evaluate(
      <Agent provider={provider}>
        <Tool use={tool} />
        inspect
      </Agent>,
    )
    await new AmlRuntime({ trace: visibleSink }).evaluate(
      <Agent provider={provider}>
        <Tool use={tool} />
        inspect
      </Agent>,
    )

    expect(JSON.stringify(hiddenEvents)).not.toContain(
      "TOOL_SECRET",
    )

    const toolEnd = visibleEvents.find(
      (event) =>
        event.type === "span.end" &&
        event.kind === "tool",
    )
    const toolStart = visibleEvents.find(
      (event) =>
        event.type === "span.start" &&
        event.kind === "tool",
    )

    expect(toolStart?.attributes).toEqual({
      input: '{"secret":"TOOL_SECRET"}',
    })
    expect(toolEnd?.attributes).toEqual({
      output: '{"echoed":"TOOL_SECRET"}',
    })
  })

  it("uses one Tool transport snapshot regardless of content tracing", async () => {
    const tool = defineTool({
      description: "Read one stateful value",
      input: z.object({ value: z.string() }),
      name: "read_once",
      execute: ({ value }) => ({ value }),
    })

    async function run(captureContent: boolean) {
      const events: AmlTraceEvent[] = []
      let getterReads = 0
      let toolOutput: unknown
      const providerInput = Object.defineProperty({}, "value", {
        enumerable: true,
        get() {
          getterReads += 1
          return getterReads === 1 ? "stable" : 42
        },
      })
      const provider = new DeterministicAgentProvider({
        async respond(request, context) {
          const callable = request.tools.find(
            (candidate) => candidate.name === "read_once",
          )

          if (callable?.kind !== "javascript") {
            throw new Error("Expected read_once Tool")
          }

          toolOutput = await callable.execute(
            providerInput,
            {
              signal: context.signal,
              trace: context.trace,
            },
          )
          return { text: "done" }
        },
      })
      const trace = ((event: AmlTraceEvent) => {
        events.push(event)
      }) as TraceSink

      if (captureContent) {
        Object.defineProperty(trace, "captureContent", {
          value: true,
        })
      }

      await new AmlRuntime({ trace }).evaluate(
        <Agent provider={provider}>
          <Tool use={tool} />
          inspect
        </Agent>,
      )

      return { events, getterReads, toolOutput }
    }

    const hidden = await run(false)
    const visible = await run(true)

    expect(hidden.getterReads).toBe(1)
    expect(visible.getterReads).toBe(1)
    expect(hidden.toolOutput).toEqual({ value: "stable" })
    expect(visible.toolOutput).toEqual({ value: "stable" })
    expect(JSON.stringify(hidden.events)).not.toContain("stable")
    expect(JSON.stringify(visible.events)).toContain(
      '"input":"{\\"value\\":\\"stable\\"}"',
    )
  })

  it("traces Tool transport rejection even when the provider recovers", async () => {
    const events: AmlTraceEvent[] = []
    let toolError: unknown
    const tool = defineTool({
      description: "Reject non-JSON transport data",
      input: z.object({ value: z.string() }),
      name: "transport_guard",
      execute: ({ value }) => ({ value }),
    })
    const provider = new DeterministicAgentProvider({
      async respond(request, context) {
        const callable = request.tools.find(
          (candidate) => candidate.name === "transport_guard",
        )

        if (callable?.kind !== "javascript") {
          throw new Error("Expected transport_guard Tool")
        }

        try {
          await callable.execute(
            { value: 1n },
            {
              signal: context.signal,
              trace: context.trace,
            },
          )
        } catch (error) {
          toolError = error
        }

        return { text: "recovered" }
      },
    })

    await expect(
      new AmlRuntime({
        trace: (event) => events.push(event),
      }).evaluate(
        <Agent provider={provider}>
          <Tool use={tool} />
          inspect
        </Agent>,
      ),
    ).resolves.toBe("recovered")

    expect(toolError).toMatchObject({
      message: 'Tool "transport_guard" input is not valid JSON',
    })

    const start = events.find(
      (event) =>
        event.type === "span.start" &&
        event.kind === "tool",
    )
    const end = events.find(
      (event) =>
        event.type === "span.end" &&
        event.kind === "tool",
    )

    expect(start).toMatchObject({ name: "transport_guard" })
    expect(start?.attributes).toEqual({})
    expect(end).toMatchObject({
      attributes: { "error.type": "ToolInputError" },
      spanId: start?.spanId,
      status: "error",
    })
  })

  it("isolates asynchronous observer failures from evaluation", async () => {
    const errors: unknown[] = []
    const sink = vi.fn((_event: AmlTraceEvent) =>
      Promise.reject(new Error("async trace failure")),
    ) as unknown as TraceSink

    await expect(
      new AmlRuntime({
        onTraceError(error) {
          errors.push(error)
        },
        trace: sink,
      }).evaluate("stable"),
    ).resolves.toBe("stable")

    await new Promise((resolve) => setImmediate(resolve))
    expect(sink).toHaveBeenCalled()
    expect(
      errors.some(
        (error) =>
          error instanceof Error &&
          error.message === "async trace failure",
      ),
    ).toBe(true)
  })

  it("masks component evaluate authority from asynchronous observers", async () => {
    const attempts: Array<{
      readonly error: unknown
      readonly phase: string
    }> = []

    function attemptEvaluate(phase: string): void {
      let error: unknown

      try {
        void evaluate(`observer:${phase}`)
      } catch (cause) {
        error = cause
      }

      attempts.push({ error, phase })
    }

    function observerThenable(prefix: string): object {
      const value = {}

      Object.defineProperty(value, "then", {
        get() {
          attemptEvaluate(`${prefix}:getter`)

          return (resolve: (value?: unknown) => void) => {
            attemptEvaluate(`${prefix}:then`)
            resolve()
          }
        },
      })

      return value
    }

    const trace = ((event: AmlTraceEvent) =>
      event.type === "span.start" &&
      event.kind === "component" &&
      event.name === "Nested"
        ? observerThenable("sink")
        : undefined) as unknown as TraceSink

    function Nested() {
      return "nested"
    }

    async function Workflow() {
      return await evaluate(<Nested />)
    }

    await expect(
      new AmlRuntime({
        trace,
      }).evaluate(<Workflow />),
    ).resolves.toBe("nested")

    await new Promise((resolve) => setImmediate(resolve))

    expect(attempts.map(({ phase }) => phase)).toEqual([
      "sink:getter",
      "sink:then",
    ])
    expect(attempts).toSatisfy(
      (
        values: Array<{
          readonly error: unknown
          readonly phase: string
        }>,
      ) =>
        values.every(
          ({ error }) =>
            error instanceof Error &&
            error.message.includes(
              "only available while an AML component is active",
            ),
        ),
    )
  })

  it("warns once when a failing sink has no secondary handler", async () => {
    const stderr = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined)

    try {
      await expect(
        new AmlRuntime({
          trace() {
            throw new Error("broken observer")
          },
        }).evaluate("stable"),
      ).resolves.toBe("stable")

      expect(stderr).toHaveBeenCalledTimes(1)
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("[aml] trace listener failed"),
      )
    } finally {
      stderr.mockRestore()
    }
  })

  it("does not coerce hostile thrown values while recording failures", async () => {
    const thrown = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("trace inspected thrown proxy")
        },
      },
    )
    const sink = (() => undefined) as TraceSink

    Object.defineProperty(sink, "captureContent", {
      value: true,
    })

    function BrokenComponent(): never {
      throw thrown
    }

    const error = await new AmlRuntime({ trace: sink })
      .evaluate(<BrokenComponent />)
      .catch((cause: unknown) => cause)

    expect(error).toBe(thrown)
  })

  it("masks component-local evaluate access from observers", async () => {
    const observerErrors: unknown[] = []

    async function Workflow() {
      const nested = await evaluate("nested")
      return `result:${nested}`
    }

    await expect(
      new AmlRuntime({
        trace() {
          try {
            void evaluate("observer")
          } catch (error) {
            observerErrors.push(error)
          }
        },
      }).evaluate(<Workflow />),
    ).resolves.toBe("result:nested")

    expect(observerErrors.length).toBeGreaterThan(0)
    expect(observerErrors).toSatisfy((errors: unknown[]) =>
      errors.every(
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "only available while an AML component is active",
          ),
      ),
    )
  })

  it("isolates throwing and rejecting console writers", async () => {
    const errors: unknown[] = []
    let calls = 0
    const trace = createConsoleTracer({
      write() {
        calls += 1

        if (calls === 1) {
          throw new Error("writer threw")
        }

        return Promise.reject(
          new Error("writer rejected"),
        ) as never
      },
    })

    await expect(
      new AmlRuntime({
        onTraceError(error) {
          errors.push(error)
        },
        trace,
      }).evaluate("stable"),
    ).resolves.toBe("stable")

    await new Promise((resolve) => setImmediate(resolve))
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "writer threw" }),
        expect.objectContaining({ message: "writer rejected" }),
      ]),
    )
  })

  it("preserves a provider's narrower Tool cancellation signal", async () => {
    const providerController = new AbortController()
    let receivedSignal: AbortSignal | undefined
    const tool = defineTool({
      description: "Observe provider cancellation",
      input: z.object({}),
      name: "observe_signal",
      execute: (_input, context) => {
        receivedSignal = context.signal
        return { ok: true }
      },
    })
    const provider = new DeterministicAgentProvider({
      async respond(request, context) {
        const callable = request.tools.find(
          (candidate) => candidate.name === "observe_signal",
        )

        if (callable?.kind !== "javascript") {
          throw new Error("Expected observe_signal Tool")
        }

        await callable.execute(
          {},
          {
            signal: providerController.signal,
            trace: context.trace,
          },
        )
        return { text: "done" }
      },
    })

    await new AmlRuntime().evaluate(
      <Agent provider={provider}>
        <Tool use={tool} />
        inspect
      </Agent>,
    )

    expect(receivedSignal).toBe(providerController.signal)
  })

  it("records MCP provenance without transport configuration or secrets", async () => {
    const events: AmlTraceEvent[] = []
    const stdio = defineMcpServer({
      name: "local-index",
      transport: {
        command: "PRIVATE_MCP_COMMAND",
        env: { TOKEN: "PRIVATE_MCP_ENV" },
        type: "stdio",
      },
    })
    const remote = defineMcpServer({
      name: "remote-index",
      transport: {
        headers: {
          Authorization: "Bearer PRIVATE_MCP_TOKEN",
        },
        type: "streamable-http",
        url: "https://private.example.test/mcp",
      },
    })

    await new AmlRuntime({
      agentProvider: new DeterministicAgentProvider(),
      trace: (event) => events.push(event),
    }).evaluate(
      <Agent>
        <Mcp name="provider-owned" />
        <Mcp use={stdio} />
        <Mcp use={remote} />
        inspect
      </Agent>,
    )

    const capabilities = events.filter(
      (event) =>
        event.type === "event" &&
        event.name === "capability.mcp",
    )

    expect(capabilities.map(({ attributes }) => attributes)).toEqual([
      { kind: "named", name: "provider-owned" },
      { kind: "stdio", name: "local-index" },
      {
        kind: "streamable-http",
        name: "remote-index",
      },
    ])

    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain("PRIVATE_MCP_COMMAND")
    expect(serialized).not.toContain("PRIVATE_MCP_ENV")
    expect(serialized).not.toContain("PRIVATE_MCP_TOKEN")
    expect(serialized).not.toContain("private.example.test")
  })

  it("isolates correlation and sequence counters across concurrent evaluations", async () => {
    const events: AmlTraceEvent[] = []
    const runtime = new AmlRuntime({
      trace: (event) => events.push(event),
    })

    await expect(
      Promise.all([
        runtime.evaluate("first"),
        runtime.evaluate("second"),
      ]),
    ).resolves.toEqual(["first", "second"])

    const byRun = new Map<string, AmlTraceEvent[]>()

    for (const event of events) {
      const runEvents = byRun.get(event.runId) ?? []

      runEvents.push(event)
      byRun.set(event.runId, runEvents)
    }

    expect(byRun.size).toBe(2)

    for (const runEvents of byRun.values()) {
      expect(runEvents.map(({ sequence }) => sequence)).toEqual([
        1,
        2,
      ])
      expect(runEvents).toMatchObject([
        {
          kind: "evaluation",
          spanId: "trace-0",
          type: "span.start",
        },
        {
          kind: "evaluation",
          spanId: "trace-0",
          status: "ok",
          type: "span.end",
        },
      ])
    }
  })

  it("traces Agent preflight validation failures", async () => {
    const events: AmlTraceEvent[] = []

    await expect(
      new AmlRuntime({
        trace: (event) => events.push(event),
      }).evaluate(
        <Agent model={42 as never}>invalid</Agent>,
      ),
    ).rejects.toThrow("<Agent> model must be a string")

    const starts = events.filter(
      (event) =>
        event.type === "span.start" &&
        event.kind === "agent",
    )
    const ends = events.filter(
      (event) =>
        event.type === "span.end" &&
        event.kind === "agent",
    )

    expect(starts).toHaveLength(1)
    expect(ends).toMatchObject([
      {
        spanId: starts[0]?.spanId,
        status: "error",
      },
    ])
  })

  it("renders a readable console tree without content by default", async () => {
    const lines: string[] = []
    const trace = createConsoleTracer({
      write: (line) => lines.push(line),
    })

    await new AmlRuntime({
      agentProvider: new DeterministicAgentProvider({
        respond: () => ({ text: "CONSOLE_OUTPUT" }),
      }),
      trace,
    }).evaluate(<Agent>CONSOLE_PROMPT</Agent>)

    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("▶ evaluation evaluate"),
        expect.stringContaining("▶ agent Agent"),
        expect.stringContaining("✓ agent Agent"),
        expect.stringContaining("✓ evaluation evaluate"),
      ]),
    )
    expect(lines.join("\n")).not.toContain("CONSOLE_PROMPT")
    expect(lines.join("\n")).not.toContain("CONSOLE_OUTPUT")
  })

  it("attributes resource lifecycles and committed Loop transitions", async () => {
    const events: AmlTraceEvent[] = []
    const sandbox = new DeterministicSandboxProvider()
    const workspace = new DeterministicWorkspaceProvider()
    const provider = new DeterministicAgentProvider({
      supportsSandbox: () => true,
      async respond(request, context, callIndex) {
        if (callIndex === 0) {
          const stateTool = request.tools.find(
            (tool) => tool.name === "aml_set_state",
          )

          if (stateTool?.kind !== "javascript") {
            throw new Error("Expected Loop state Tool")
          }

          await stateTool.execute(
            { updates: { done: true } },
            {
              signal: context.signal,
              trace: context.trace,
            },
          )
          return { text: "discarded" }
        }

        return { text: "complete" }
      },
    })

    await expect(
      new AmlRuntime({
        trace(event) {
          events.push(event)
        },
      }).evaluate(
        <Workspace id="trace" provider={workspace}>
          <Sandbox provider={sandbox}>
            <Loop
              initial={{ done: false }}
              schema={z.object({ done: z.boolean() })}
              render={({ state }) => (
                <Agent provider={provider}>
                  done={String(state.done)}
                </Agent>
              )}
            />
          </Sandbox>
        </Workspace>,
      ),
    ).resolves.toBe("complete")

    for (const kind of [
      "workspace",
      "sandbox",
      "loop",
    ] as const) {
      const start = events.find(
        (event) =>
          event.type === "span.start" && event.kind === kind,
      )
      const end = events.find(
        (event) =>
          event.type === "span.end" && event.kind === kind,
      )

      expect(start).toBeDefined()
      expect(end).toMatchObject({
        spanId: start?.spanId,
        status: "ok",
      })
    }

    const root = events.find(
      (event) =>
        event.type === "span.start" &&
        event.kind === "evaluation",
    )
    const workspaceStart = events.find(
      (event) =>
        event.type === "span.start" &&
        event.kind === "workspace",
    )
    const sandboxStart = events.find(
      (event) =>
        event.type === "span.start" &&
        event.kind === "sandbox",
    )
    const loopStart = events.find(
      (event) =>
        event.type === "span.start" &&
        event.kind === "loop",
    )
    const agentStarts = events.filter(
      (event) =>
        event.type === "span.start" &&
        event.kind === "agent",
    )

    expect(workspaceStart?.parentSpanId).toBe(root?.spanId)
    expect(sandboxStart?.parentSpanId).toBe(
      workspaceStart?.spanId,
    )
    expect(loopStart?.parentSpanId).toBe(sandboxStart?.spanId)
    expect(agentStarts).toHaveLength(2)
    expect(agentStarts).toSatisfy((starts: AmlTraceEvent[]) =>
      starts.every(
        (event) => event.parentSpanId === loopStart?.spanId,
      ),
    )

    expect(
      events.find(
        (event) =>
          event.type === "event" &&
          event.name === "loop.transition",
      ),
    ).toMatchObject({
      attributes: {
        iteration: 1,
        name: "Loop",
        transition: 1,
      },
    })
    expect(workspace.saves).toHaveLength(1)
    expect(workspace.releases).toHaveLength(1)
    expect(sandbox.releases).toHaveLength(1)
  })

  it("closes failed Agent and resource spans after cleanup", async () => {
    const events: AmlTraceEvent[] = []
    const sandbox = new DeterministicSandboxProvider()
    const workspace = new DeterministicWorkspaceProvider()
    const provider = new DeterministicAgentProvider({
      respond: () => {
        throw new Error("provider exploded")
      },
      supportsSandbox: () => true,
    })

    await expect(
      new AmlRuntime({
        trace: (event) => events.push(event),
      }).evaluate(
        <Workspace id="failure" provider={workspace}>
          <Sandbox provider={sandbox}>
            <Agent provider={provider}>fail</Agent>
          </Sandbox>
        </Workspace>,
      ),
    ).rejects.toThrow('Agent "deterministic"')

    for (const kind of [
      "agent",
      "sandbox",
      "workspace",
      "evaluation",
    ] as const) {
      expect(
        events.find(
          (event) =>
            event.type === "span.end" &&
            event.kind === kind,
        ),
      ).toMatchObject({ status: "error" })
    }

    expect(workspace.saves).toHaveLength(1)
    expect(workspace.releases).toHaveLength(1)
    expect(sandbox.releases).toHaveLength(1)
  })
})
