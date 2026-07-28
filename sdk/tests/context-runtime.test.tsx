import { z } from "zod"
import { describe, expect, expectTypeOf, it } from "vitest"

import { Agent } from "../src/components/agent/agent.js"
import type { AgentExecutionContext } from "../src/components/agent/agent-execution-context.js"
import type { AmlContext } from "../src/components/context/aml-context.js"
import { createContext } from "../src/components/context/create-context.js"
import { useContext } from "../src/components/context/use-context.js"
import { Loop } from "../src/components/loop/loop.js"
import { System } from "../src/components/system/system.js"
import { defineTool } from "../src/components/tool/define-tool.js"
import { Tool } from "../src/components/tool/tool.js"
import type { AmlRenderable } from "../src/core/aml-node.js"
import type { AmlTraceEvent } from "../src/observability/trace-event.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { evaluate } from "../src/core/evaluate.js"
import { jsx } from "../src/jsx-runtime.js"
import { DeterministicAgentProvider } from "../src/testing/deterministic-agent-provider.js"

describe("AML Context", () => {
  it("provides one exact dependency identity to descendant components", async () => {
    const Session = createContext<{ readonly userId: string }>("Session")
    const session = { userId: "user-42" }
    let observed: unknown

    function Reader() {
      observed = useContext(Session)
      expectTypeOf(useContext(Session)).toEqualTypeOf<{
        readonly userId: string
      }>()
      return `user:${useContext(Session).userId}`
    }

    await expect(
      new AmlRuntime().evaluate(
        <Session.Provider value={session}>
          <Reader />
        </Session.Provider>
      )
    ).resolves.toBe("user:user-42")
    expect(observed).toBe(session)
    expect(Object.isFrozen(session)).toBe(false)
  })

  it("shadows only the nested lexical subtree", async () => {
    const Session = createContext<string>("Session")

    function Reader() {
      return useContext(Session)
    }

    await expect(
      new AmlRuntime().evaluate(
        <Session.Provider value="outer">
          <Reader />:
          <Session.Provider value="inner">
            <Reader />
          </Session.Provider>
          :<Reader />
        </Session.Provider>
      )
    ).resolves.toBe("outer:inner:outer")
  })

  it("uses exact Context identity rather than diagnostic name", async () => {
    const First = createContext("Duplicate", "first-default")
    const Second = createContext("Duplicate", "second-default")

    function Reader() {
      return `${useContext(First)}:${useContext(Second)}`
    }

    await expect(
      new AmlRuntime().evaluate(
        <First.Provider value="first-provided">
          <Reader />
        </First.Provider>
      )
    ).resolves.toBe("first-provided:second-default")
  })

  it("distinguishes omitted defaults from explicit undefined", async () => {
    const Required = createContext<string>("Required")
    const Optional = createContext<string | undefined>("Optional", undefined)

    function ReadOptional() {
      return useContext(Optional) === undefined ? "undefined-default" : "unexpected"
    }

    function ReadRequired() {
      return useContext(Required)
    }

    await expect(new AmlRuntime().evaluate(<ReadOptional />)).resolves.toBe("undefined-default")
    await expect(new AmlRuntime().evaluate(<ReadRequired />)).rejects.toThrow(
      'Context "Required" has no Provider or default value'
    )
  })

  it("keeps Context Provider transparent to Agent message channels", async () => {
    const Instructions = createContext<string>("Instructions")
    const provider = new DeterministicAgentProvider({
      respond(request) {
        expect(request.system).toBe("system:careful")
        expect(request.tools.map(tool => tool.name)).toEqual(["session_lookup"])
        return { text: request.prompt }
      },
    })

    function Capabilities() {
      const instruction = useContext(Instructions)
      const lookup = defineTool({
        description: "Read session data.",
        execute: () => instruction,
        input: z.object({}),
        name: "session_lookup",
      })

      return [<System>system:{instruction}</System>, <Tool use={lookup} />]
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          <Instructions.Provider value="careful">
            <Capabilities />
          </Instructions.Provider>
          act
        </Agent>
      )
    ).resolves.toBe("act")
  })

  it("inherits Context through component-local evaluate without leaking nested Providers", async () => {
    const Session = createContext<string>("Session")
    let renders = 0

    function Reader() {
      return useContext(Session)
    }

    async function Workflow() {
      renders += 1
      const inherited = await evaluate(<Reader />)
      const shadowed = await evaluate(
        <Session.Provider value="nested">
          <Reader />
        </Session.Provider>
      )

      return `${inherited}:${shadowed}:${useContext(Session)}`
    }

    await expect(
      new AmlRuntime().evaluate(
        <Session.Provider value="root">
          <Workflow />
        </Session.Provider>
      )
    ).resolves.toBe("root:nested:root")
    expect(renders).toBe(1)
  })

  it("isolates concurrent nested branches while preserving their parent binding", async () => {
    const Session = createContext<string>("Session")
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })

    async function Reader({ gate }: { readonly gate?: Promise<void> }) {
      const before = useContext(Session)
      await gate
      return `${before}/${useContext(Session)}`
    }

    async function Workflow() {
      const branches = Promise.all([
        evaluate(
          <Session.Provider value="first">
            <Reader gate={firstGate} />
          </Session.Provider>
        ),
        evaluate(
          <Session.Provider value="second">
            <Reader />
          </Session.Provider>
        ),
      ])

      await Promise.resolve()
      expect(useContext(Session)).toBe("parent")
      releaseFirst?.()
      const [first, second] = await branches

      return `${first}:${second}:${useContext(Session)}`
    }

    await expect(
      new AmlRuntime().evaluate(
        <Session.Provider value="parent">
          <Workflow />
        </Session.Provider>
      )
    ).resolves.toBe("first/first:second/second:parent")
  })

  it("isolates the same Context across concurrent root evaluations", async () => {
    const Session = createContext<string>("Session")
    const runtime = new AmlRuntime()

    async function Reader() {
      const initial = useContext(Session)
      await Promise.resolve()
      return `${initial}:${useContext(Session)}`
    }

    const [first, second] = await Promise.all([
      runtime.evaluate(
        <Session.Provider value="one">
          <Reader />
        </Session.Provider>
      ),
      runtime.evaluate(
        <Session.Provider value="two">
          <Reader />
        </Session.Provider>
      ),
    ])

    expect([first, second]).toEqual(["one:one", "two:two"])
  })

  it("allows Context Provider around a structured Agent", async () => {
    const Session = createContext("Session", "default")
    const Result = z.object({ session: z.string() })
    const provider = new DeterministicAgentProvider({
      respond(request) {
        expect(request.prompt).toBe("session:provided")
        return {
          structured: { session: "provided" },
          text: "",
        }
      },
    })

    function Prompt() {
      return `session:${useContext(Session)}`
    }

    async function Workflow() {
      const result = await evaluate(
        <Session.Provider value="provided">
          <Agent>
            <Prompt />
          </Agent>
        </Session.Provider>,
        Result
      )
      expectTypeOf(result).toEqualTypeOf<{
        session: string
      }>()
      return result.session
    }

    await expect(new AmlRuntime({ agentProvider: provider }).evaluate(<Workflow />)).resolves.toBe("provided")
  })

  it("preserves Context while selecting a Loop Agent wrapper", async () => {
    const Session = createContext<string>("Session")
    const State = z.object({ done: z.boolean() })
    const provider = new DeterministicAgentProvider()

    function Prompt() {
      return `loop:${useContext(Session)}`
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Loop
          initial={{ done: true }}
          name="context-loop"
          render={() => (
            <Session.Provider value="iteration">
              <Agent>
                <Prompt />
              </Agent>
            </Session.Provider>
          )}
          schema={State}
        />
      )
    ).resolves.toBe("loop:iteration")
  })

  it("captures a session repository in a Tool without rendering or tracing it", async () => {
    const secret = "repository-secret-that-must-not-leak"
    const repository = {
      secret,
      async load() {
        return ["order-1", "order-2"]
      },
    }
    const SessionRepository = createContext<typeof repository>("SessionRepository")
    const events: AmlTraceEvent[] = []
    const trace = Object.assign((event: AmlTraceEvent) => events.push(event), { captureContent: true as const })
    let toolRepository: unknown
    const provider = new DeterministicAgentProvider({
      async respond(request, context) {
        const tool = request.tools.find(candidate => candidate.name === "load_session_orders")

        if (tool?.kind !== "javascript") {
          throw new Error("session Tool was not granted")
        }

        const result = await tool.execute({}, toolContext(context))
        return { text: JSON.stringify(result) }
      },
    })

    function SessionAgent() {
      const scopedRepository = useContext(SessionRepository)
      toolRepository = scopedRepository
      const loadOrders = defineTool({
        description: "Load orders for the active session.",
        execute: async () => await scopedRepository.load(),
        input: z.object({}),
        name: "load_session_orders",
      })

      return (
        <Agent>
          <Tool use={loadOrders} />
          Load the active session orders.
        </Agent>
      )
    }

    await expect(
      new AmlRuntime({
        agentProvider: provider,
        trace,
      }).evaluate(
        <SessionRepository.Provider value={repository}>
          <SessionAgent />
        </SessionRepository.Provider>
      )
    ).resolves.toBe('["order-1","order-2"]')

    expect(toolRepository).toBe(repository)
    expect(provider.calls[0]?.request.prompt).toBe("Load the active session orders.")
    expect(JSON.stringify(provider.calls[0]?.request)).not.toContain(secret)
    expect(JSON.stringify(events)).not.toContain(secret)
  })

  it("masks Context from provider callbacks and detached component work", async () => {
    const Session = createContext("Session", "fallback")
    const providerErrors: unknown[] = []
    const detachedErrors: unknown[] = []
    let detachedDone: (() => void) | undefined
    const detached = new Promise<void>(resolve => {
      detachedDone = resolve
    })
    const provider = new DeterministicAgentProvider({
      respond() {
        try {
          useContext(Session)
        } catch (error) {
          providerErrors.push(error)
        }

        return { text: "done" }
      },
    })

    function Workflow() {
      setTimeout(() => {
        try {
          useContext(Session)
        } catch (error) {
          detachedErrors.push(error)
        } finally {
          detachedDone?.()
        }
      }, 0)

      return <Agent>run</Agent>
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Session.Provider value="provided">
          <Workflow />
        </Session.Provider>
      )
    ).resolves.toBe("done")
    await detached

    expect(providerErrors).toHaveLength(1)
    expect(detachedErrors).toHaveLength(1)
    expect(providerErrors[0]).toMatchObject({
      message: "useContext() is only available while an AML component is active",
    })
    expect(detachedErrors[0]).toMatchObject({
      message: "useContext() is only available while an AML component is active",
    })
  })

  it("rejects invalid definitions, lookalikes, and Provider props", async () => {
    expect(() => createContext("")).toThrow("Context name must be a non-empty normalized string")
    expect(() => createContext(" Session ")).toThrow("Context name must be a non-empty normalized string")

    const Session = createContext<string>("Session")
    const fake = {
      name: "Session",
      Provider: Session.Provider,
    } as AmlContext<string>

    function ReadFake() {
      return useContext(fake)
    }

    await expect(new AmlRuntime().evaluate(<ReadFake />)).rejects.toThrow(
      "useContext() requires a Context returned by createContext()"
    )
    await expect(new AmlRuntime().evaluate(jsx(Session.Provider, {} as never))).rejects.toThrow(
      "<Session.Provider> requires a value prop"
    )
  })

  it("captures hostile Provider value and children accessors once in stable order", async () => {
    const Session = createContext<string>("Session")
    const State = z.object({ done: z.boolean() })

    function Reader() {
      return useContext(Session)
    }

    for (const boundary of ["evaluation", "loop"] as const) {
      const reads: string[] = []
      const node = forgedProviderNode(
        Session,
        reads,
        boundary === "evaluation" ? (
          <Reader />
        ) : (
          <Agent>
            <Reader />
          </Agent>
        )
      )
      const provider = new DeterministicAgentProvider()
      const tree =
        boundary === "evaluation" ? (
          node
        ) : (
          <Loop initial={{ done: true }} name="hostile-context-loop" render={() => node} schema={State} />
        )

      await expect(new AmlRuntime({ agentProvider: provider }).evaluate(tree)).resolves.toBe("provided")
      expect(reads).toEqual(["value", "children"])
    }
  })

  it("rejects useContext outside an active component even with a default", () => {
    const Session = createContext("Session", "fallback")

    expect(() => useContext(Session)).toThrow("useContext() is only available while an AML component is active")
  })
})

/**
 * Models a compatible cross-copy node whose props are not SDK-normalized.
 *
 * AmlNode's realm-wide brand deliberately supports physical package copies, so
 * runtime boundaries must not assume every accepted descriptor has plain props.
 */
function forgedProviderNode(context: AmlContext<string>, reads: string[], children: AmlRenderable): AmlRenderable {
  const props = Object.defineProperties(
    {},
    {
      children: {
        enumerable: true,
        get() {
          reads.push("children")
          return children
        },
      },
      value: {
        enumerable: true,
        get() {
          reads.push("value")
          return "provided"
        },
      },
    }
  )

  return {
    $$typeof: Symbol.for("@aml-jsx/sdk/node"),
    props,
    type: context.Provider,
  } as unknown as AmlRenderable
}

/**
 * Narrows provider execution context to the JavaScript Tool contract.
 */
function toolContext(context: AgentExecutionContext): Readonly<{
  signal: AbortSignal
  trace: AgentExecutionContext["trace"]
}> {
  return Object.freeze({
    signal: context.signal,
    trace: context.trace,
  })
}
