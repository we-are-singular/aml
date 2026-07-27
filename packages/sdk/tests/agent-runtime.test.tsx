import { describe, expect, expectTypeOf, it } from "vitest"

import { Agent } from "../src/components/agent/agent.js"
import type { AgentProvider } from "../src/components/agent/agent-provider.js"
import type { AgentRequest } from "../src/components/agent/agent-request.js"
import { defineAgentProvider } from "../src/components/agent/define-agent-provider.js"
import { System } from "../src/components/system/system.js"
import type { AmlRenderable } from "../src/core/aml-node.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { EvaluationError } from "../src/core/evaluation-error.js"
import { jsx } from "../src/jsx-runtime.js"
import type { AmlTraceEvent } from "../src/observability/trace-event.js"
import { agentProviderConformance } from "../src/testing/agent-provider-conformance.js"
import { DeterministicAgentProvider } from "../src/testing/deterministic-agent-provider.js"

describe("Agent", () => {
  it("uses the runtime provider unless an Agent overrides it", async () => {
    const runtimeProvider = new DeterministicAgentProvider({
      name: "runtime",
      respond: (request) => ({ text: `runtime:${request.prompt}` }),
    })
    const localProvider = new DeterministicAgentProvider({
      name: "local",
      respond: (request) => ({ text: `local:${request.prompt}` }),
    })
    const runtime = new AmlRuntime({ agentProvider: runtimeProvider })

    await expect(
      runtime.evaluate([
        jsx(Agent, { children: "first" }),
        jsx(Agent, {
          children: "second",
          model: "provider/model",
          provider: localProvider,
        }),
      ]),
    ).resolves.toBe("runtime:firstlocal:second")

    expect(runtimeProvider.calls).toHaveLength(1)
    expect(runtimeProvider.calls[0]?.request.model).toBeUndefined()
    expect(localProvider.calls).toHaveLength(1)
    expect(localProvider.calls[0]?.request.model).toBe("provider/model")
  })

  it("resolves child Agents and System subtrees before their parent", async () => {
    const events: string[] = []
    const traceEvents: AmlTraceEvent[] = []
    const specialist = new DeterministicAgentProvider({
      name: "specialist",
      respond(request) {
        events.push(`specialist:${request.prompt}`)
        return {
          text:
            request.prompt === "Write rules"
              ? "generated rules"
              : "evidence result",
        }
      },
    })
    const coordinator = new DeterministicAgentProvider({
      name: "coordinator",
      respond(request) {
        events.push("coordinator")
        expect(request.model).toBe("coordinator/model")
        expect(request.prompt).toBe("before:evidence result:after")
        expect(request.system).toBe(
          "runtime system\nfixed system\ngenerated rules\nasync guidance",
        )
        return { text: "final answer" }
      },
    })

    async function AsyncGuidance() {
      events.push("guidance:start")
      await Promise.resolve()
      events.push("guidance:end")
      return " async guidance "
    }

    const tree = jsx(Agent, {
      children: [
        jsx(System, {
          children: jsx(Agent, {
            children: "Write rules",
            model: "specialist/fast",
            provider: specialist,
          }),
        }),
        jsx(System, { children: jsx(AsyncGuidance, {}) }),
        "before:",
        jsx(Agent, {
          children: "evidence",
          provider: specialist,
        }),
        ":after",
      ],
      model: "coordinator/model",
      provider: coordinator,
      system: " fixed system ",
    })
    const runtime = new AmlRuntime({
      system: " runtime system ",
      trace: (event) => traceEvents.push(event),
    })

    await expect(runtime.evaluate(tree)).resolves.toBe("final answer")
    expect(events).toEqual([
      "specialist:Write rules",
      "guidance:start",
      "guidance:end",
      "specialist:evidence",
      "coordinator",
    ])

    const parentTrace = coordinator.calls[0]?.context.trace
    const systemSpan = traceEvents.find(
      (event) =>
        event.type === "span.start" &&
        event.kind === "system",
    )

    expect(parentTrace).toBeDefined()
    expect(specialist.calls[0]?.context.trace.parentSpanId).toBe(
      systemSpan?.spanId,
    )
    expect(specialist.calls[1]?.context.trace.parentSpanId).toBe(
      parentTrace?.spanId,
    )
    expect(specialist.calls[0]?.context.trace.runId).toBe(
      parentTrace?.runId,
    )

    // Providers receive the exact identity published for their Agent span;
    // correlation must never assign two parents to one span ID.
    for (const call of [
      ...specialist.calls,
      ...coordinator.calls,
    ]) {
      expect(
        traceEvents.find(
          (event) =>
            event.type === "span.start" &&
            event.kind === "agent" &&
            event.spanId === call.context.trace.spanId,
        ),
      ).toMatchObject(call.context.trace)
    }
  })

  it("accepts System descriptors returned through components", async () => {
    const provider = new DeterministicAgentProvider({
      respond: (request) => ({ text: request.system }),
    })

    function ReusableSystem() {
      return <System>component system</System>
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          <ReusableSystem />
          prompt
        </Agent>,
      ),
    ).resolves.toBe("component system")

    expect(provider.calls[0]?.request.prompt).toBe("prompt")
  })

  it("rejects invalid System placement and empty fragments", async () => {
    const provider = new DeterministicAgentProvider()
    const runtime = new AmlRuntime({ agentProvider: provider })

    await expect(runtime.evaluate(<System>outside</System>)).rejects.toThrow(
      "<System> is only valid inside <Agent>",
    )
    await expect(
      runtime.evaluate(
        <Agent>
          <System>
            <System>nested</System>
          </System>
        </Agent>,
      ),
    ).rejects.toThrow("nested <System> descriptors are invalid")
    await expect(
      runtime.evaluate(
        <Agent>
          <System> </System>
        </Agent>,
      ),
    ).rejects.toThrow("<System> must resolve to non-empty text")
    expect(provider.calls).toHaveLength(0)
  })

  it("rejects an Agent without a selected provider after resolving children", async () => {
    const events: string[] = []

    async function Child() {
      events.push("child")
      return "prompt"
    }

    await expect(
      new AmlRuntime().evaluate(
        <Agent>
          <Child />
        </Agent>,
      ),
    ).rejects.toThrow("Agent span-1 has no provider")
    expect(events).toEqual(["child"])
  })

  it("attributes provider failures to the Agent and preserves their cause", async () => {
    const failure = new Error("provider exploded")
    const provider: AgentProvider = {
      name: "broken",
      async run() {
        throw failure
      },
    }

    const error = await new AmlRuntime({
      agentProvider: provider,
    })
      .evaluate(<Agent>prompt</Agent>)
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(EvaluationError)
    expect(error).toHaveProperty(
      "message",
      'Agent "broken" (span-1) failed',
    )
    expect(error).toHaveProperty("cause", failure)
  })

  it("rejects invalid provider responses with Agent identity", async () => {
    const provider = {
      name: "invalid-response",
      async run() {
        return {} as never
      },
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>prompt</Agent>,
      ),
    ).rejects.toThrow(
      'Agent "invalid-response" (span-1) returned an invalid response',
    )
  })

  it("reads provider response text exactly once", async () => {
    let reads = 0
    const provider: AgentProvider = {
      name: "getter-response",
      async run() {
        return {
          get text() {
            reads += 1

            if (reads > 1) {
              throw new Error("text read twice")
            }

            return "captured once"
          },
        }
      },
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>prompt</Agent>,
      ),
    ).resolves.toBe("captured once")
    expect(reads).toBe(1)
  })

  it("attributes a throwing response accessor to its Agent", async () => {
    const failure = new Error("text exploded")
    const provider: AgentProvider = {
      name: "getter-failure",
      async run() {
        return {
          get text(): string {
            throw failure
          },
        }
      },
    }

    const error = await new AmlRuntime({ agentProvider: provider })
      .evaluate(<Agent>prompt</Agent>)
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(EvaluationError)
    expect(error).toHaveProperty(
      "message",
      'Agent "getter-failure" (span-1) returned an invalid response',
    )
    expect(error).toHaveProperty("cause", failure)
  })

  it("prevents a failed child Agent from invoking its parent", async () => {
    const failure = new Error("child failed")
    const child: AgentProvider = {
      name: "child",
      async run() {
        throw failure
      },
    }
    const parent = new DeterministicAgentProvider({ name: "parent" })

    const error = await new AmlRuntime({ agentProvider: parent })
      .evaluate(
        <Agent>
          <Agent provider={child}>child prompt</Agent>
          parent prompt
        </Agent>,
      )
      .catch((cause: unknown) => cause)

    expect(error).toHaveProperty(
      "message",
      'Agent "child" (span-2) failed',
    )
    expect(error).toHaveProperty("cause", failure)
    expect(parent.calls).toHaveLength(0)
  })

  it("enforces the default Agent-call budget", async () => {
    const provider = new DeterministicAgentProvider()
    const agents = Array.from({ length: 33 }, (_, index) => (
      <Agent provider={provider}>{index}</Agent>
    ))

    await expect(new AmlRuntime().evaluate(agents)).rejects.toThrow(
      "AML evaluation exceeded maxAgentCalls 32 at Agent span-33",
    )
    expect(provider.calls).toHaveLength(32)
  })

  it("accepts zero as an unlimited Agent-call budget", async () => {
    const provider = new DeterministicAgentProvider()
    const agents = Array.from({ length: 33 }, (_, index) => (
      <Agent provider={provider}>{index}</Agent>
    ))

    await expect(
      new AmlRuntime({ maxAgentCalls: 0 }).evaluate(agents),
    ).resolves.toBe(Array.from({ length: 33 }, (_, index) => index).join(""))
    expect(provider.calls).toHaveLength(33)
  })

  it("recognizes Agent and System markers from another SDK copy", async () => {
    const provider = new DeterministicAgentProvider({
      respond: (request) => ({
        text: `${request.system}|${request.prompt}`,
      }),
    })
    const nodeBrand = Symbol.for("@aml/sdk/node")
    const primitiveKind = Symbol.for("@aml/sdk/primitive-kind")

    function ForeignAgent(): never {
      throw new Error("Foreign Agent was invoked as a component")
    }

    function ForeignSystem(): never {
      throw new Error("Foreign System was invoked as a component")
    }

    Object.defineProperty(ForeignAgent, primitiveKind, { value: "agent" })
    Object.defineProperty(ForeignSystem, primitiveKind, {
      value: "system",
    })

    const systemNode = {
      $$typeof: nodeBrand,
      props: { children: "foreign system" },
      type: ForeignSystem,
    }
    const agentNode = {
      $$typeof: nodeBrand,
      props: {
        children: [systemNode, "foreign prompt"],
        provider,
      },
      type: ForeignAgent,
    }

    await expect(
      new AmlRuntime().evaluate(agentNode),
    ).resolves.toBe("foreign system|foreign prompt")
  })

  it("does not type an unbranded descriptor as AML", () => {
    expectTypeOf<{
      props: {}
      type: () => string
    }>().not.toMatchTypeOf<AmlRenderable>()
  })

  it("captures an explicit provider's invocation members once", async () => {
    let nameReads = 0
    let runReads = 0
    const provider: AgentProvider = {
      get name() {
        nameReads += 1
        return "captured-provider"
      },
      get run() {
        runReads += 1
        return async (request: AgentRequest) => ({ text: request.prompt })
      },
    }

    await expect(
      new AmlRuntime().evaluate(
        <Agent provider={provider}>captured once</Agent>,
      ),
    ).resolves.toBe("captured once")

    expect(nameReads).toBe(1)
    expect(runReads).toBe(1)
  })
})

describe("defineAgentProvider", () => {
  it("freezes the exact provider without breaking private state", async () => {
    class StatefulProvider implements AgentProvider {
      readonly #prefix = "state:"
      readonly name = "stateful"

      async run(request: AgentRequest) {
        return { text: `${this.#prefix}${request.prompt}` }
      }
    }

    const implementation = new StatefulProvider()
    const provider = defineAgentProvider(implementation)

    expect(provider).toBe(implementation)
    expect(provider.name).toBe("stateful")
    expect(Object.isFrozen(provider)).toBe(true)
    await expect(
      provider.run({
        mcpServers: [],
        prompt: "prompt",
        system: "",
        tools: [],
      }),
    ).resolves.toEqual({ text: "state:prompt" })
  })

  it("preserves literal provider types", () => {
    const provider = defineAgentProvider({
      name: "literal-provider" as const,
      async run() {
        return { text: "done" }
      },
    })

    expectTypeOf(provider.name).toEqualTypeOf<"literal-provider">()
  })

  it("rejects incomplete provider definitions", () => {
    expect(() =>
      defineAgentProvider({ name: " ", run: async () => ({ text: "" }) }),
    ).toThrow("Agent provider name must already be normalized")
    expect(() =>
      defineAgentProvider({ name: "missing-run" } as never),
    ).toThrow("Agent provider run must be a function")
    const callable = Object.assign(function callableProvider() {}, {
      async run() {
        return { text: "" }
      },
    })

    expect(() => defineAgentProvider(callable)).toThrow(
      "Agent provider must be an object",
    )
  })
})

describe("agentProviderConformance", () => {
  it("exercises a deterministic provider through frozen public contracts", async () => {
    const provider = new DeterministicAgentProvider()

    await expect(agentProviderConformance(provider)).resolves.toBeUndefined()
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]?.request.prompt).toBe(
      "agent-provider-conformance",
    )
    expect(provider.calls[0]?.request.followUps).toEqual([
      "agent-provider-conformance-final",
    ])
    expect(Object.isFrozen(provider.calls[0]?.request.followUps)).toBe(
      true,
    )
    expect(Object.isFrozen(provider.calls[0]?.request)).toBe(true)
    expect(Object.isFrozen(provider.calls[0]?.context)).toBe(true)

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>runtime-compatible</Agent>,
      ),
    ).resolves.toBe("runtime-compatible")
  })

  it("rejects providers that violate the response contract", async () => {
    const provider: AgentProvider = {
      name: "invalid",
      async run() {
        return {} as never
      },
    }

    await expect(agentProviderConformance(provider)).rejects.toThrow(
      "Agent provider must return a text response",
    )
  })
})

describe("Agent runtime options", () => {
  it("rejects invalid Agent-call budgets", () => {
    expect(() => new AmlRuntime({ maxAgentCalls: -1 })).toThrow(
      "maxAgentCalls must be a non-negative safe integer",
    )
    expect(() => new AmlRuntime({ maxAgentCalls: 1.5 })).toThrow(
      "maxAgentCalls must be a non-negative safe integer",
    )
  })
})
