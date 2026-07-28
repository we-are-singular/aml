import type { StandardSchemaV1 } from "@standard-schema/spec"
import { describe, expect, expectTypeOf, it } from "vitest"
import { z } from "zod"

import { Agent } from "../src/components/agent/agent.js"
import type { AgentExecutionContext } from "../src/components/agent/agent-execution-context.js"
import type { AgentProvider } from "../src/components/agent/agent-provider.js"
import type { AgentRequest } from "../src/components/agent/agent-request.js"
import { FollowUp } from "../src/components/follow-up/follow-up.js"
import { type DeepReadonly, Loop, type LoopProps } from "../src/components/loop/loop.js"
import { Sandbox } from "../src/components/sandbox/sandbox.js"
import type { AgentJavaScriptTool } from "../src/components/tool/agent-tool.js"
import { Tool } from "../src/components/tool/tool.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { evaluate } from "../src/core/evaluate.js"
import { DeterministicAgentProvider } from "../src/testing/deterministic-agent-provider.js"

describe("Loop", () => {
  it("commits staged state only after the Agent and discards stale output", async () => {
    const prompts: string[] = []
    const snapshots: unknown[] = []
    const initial = {
      findings: [] as string[],
      status: "pending" as "complete" | "pending",
    }
    const State = z.object({
      findings: z.array(z.string()),
      status: z.enum(["pending", "complete"]),
    })
    const provider: AgentProvider = {
      name: "loop",
      async run(request, context) {
        prompts.push(request.prompt)

        if (request.prompt === "investigate") {
          await executeStateTool(request, context, {
            updates: {
              findings: ["verified"],
              status: "complete",
            },
          })
          return { text: "stale response" }
        }

        return { text: `final:${request.prompt}` }
      },
    }

    const output = await new AmlRuntime({
      agentProvider: provider,
    }).evaluate(
      <Loop
        initial={initial}
        name="research"
        render={({ iteration, state }) => {
          snapshots.push(state)
          expect(iteration).toBe(snapshots.length)

          return <Agent>{state.status === "pending" ? "investigate" : state.findings.join(",")}</Agent>
        }}
        schema={State}
      />
    )

    expect(output).toBe("final:verified")
    expect(prompts).toEqual(["investigate", "verified"])
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]).not.toBe(initial)
    expect(Object.isFrozen(snapshots[0])).toBe(true)
    expect(Object.isFrozen((snapshots[0] as { findings: string[] }).findings)).toBe(true)
    expect(Object.isFrozen(initial)).toBe(false)
    expect(Object.isFrozen(initial.findings)).toBe(false)
  })

  it("keeps staged state private through the complete FollowUp session", async () => {
    const requests: AgentRequest[] = []
    const State = z.object({ done: z.boolean() })
    const provider: AgentProvider = {
      name: "turns",
      async run(request, context) {
        requests.push(request)

        if (request.prompt === "pending") {
          await executeStateTool(request, context, {
            updates: { done: true },
          })
          return { text: "stale final turn" }
        }

        return { text: "current final turn" }
      },
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Loop
          initial={{ done: false }}
          render={({ state }) => (
            <Agent>
              {state.done ? "committed" : "pending"}
              <FollowUp>Confirm using this session's history.</FollowUp>
            </Agent>
          )}
          schema={State}
        />
      )
    ).resolves.toBe("current final turn")
    expect(
      requests.map(request => ({
        followUps: request.followUps,
        prompt: request.prompt,
      }))
    ).toEqual([
      {
        followUps: ["Confirm using this session's history."],
        prompt: "pending",
      },
      {
        followUps: ["Confirm using this session's history."],
        prompt: "committed",
      },
    ])
  })

  it("grants state only to the selected outer Agent", async () => {
    const grants: string[][] = []
    const State = z.object({ done: z.boolean() })
    const provider: AgentProvider = {
      name: "scoped",
      async run(request) {
        grants.push(request.tools.map(tool => tool.name))
        return {
          text: request.prompt === "child" ? "evidence" : "finished",
        }
      },
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Loop
          initial={{ done: false }}
          render={() => (
            <Agent>
              <Agent>child</Agent>
              parent
            </Agent>
          )}
          schema={State}
        />
      )
    ).resolves.toBe("finished")
    expect(grants).toEqual([[], ["aml_set_state"]])
  })

  it("validates each complete patch atomically and leaves invalid state unchanged", async () => {
    const State = z
      .object({
        left: z.number().int(),
        right: z.number().int(),
      })
      .refine(({ left, right }) => left === right)
    let calls = 0
    const provider: AgentProvider = {
      name: "validation",
      async run(request, context) {
        calls += 1
        const tool = requireStateTool(request)

        await expect(tool.execute({ updates: { left: 1 } }, toolContext(context))).rejects.toThrow(
          "failed schema validation"
        )
        await expect(tool.execute({ updates: { missing: true } }, toolContext(context))).rejects.toThrow(
          "cannot update unknown keys: missing"
        )
        await expect(
          tool.execute({ extra: true, updates: { left: 1, right: 1 } }, toolContext(context))
        ).rejects.toThrow("must contain only updates")

        return { text: "unchanged" }
      },
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Loop
          initial={{ left: 0, right: 0 }}
          render={({ state }) => (
            <Agent>
              {state.left}:{state.right}
            </Agent>
          )}
          schema={State}
        />
      )
    ).resolves.toBe("unchanged")
    expect(calls).toBe(1)
  })

  it("serializes concurrent patches in invocation order", async () => {
    const prompts: string[] = []
    const State = z.object({ count: z.number().int() })
    const provider: AgentProvider = {
      name: "serialized",
      async run(request, context) {
        prompts.push(request.prompt)

        if (request.prompt === "0") {
          const tool = requireStateTool(request)
          await Promise.all([
            tool.execute({ updates: { count: 1 } }, toolContext(context)),
            tool.execute({ updates: { count: 2 } }, toolContext(context)),
          ])
          return { text: "stale" }
        }

        return { text: "finished" }
      },
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Loop initial={{ count: 0 }} render={({ state }) => <Agent>{state.count}</Agent>} schema={State} />
      )
    ).resolves.toBe("finished")
    expect(prompts).toEqual(["0", "2"])
  })

  it("returns the current Agent output when staged state is stable", async () => {
    const State = z.object({ done: z.boolean() })
    let calls = 0
    const provider: AgentProvider = {
      name: "stable",
      async run(request, context) {
        calls += 1
        const tool = requireStateTool(request)
        expect(Object.isFrozen(tool)).toBe(true)
        await expect(tool.execute({ updates: { done: true } }, toolContext(context))).resolves.toEqual({
          changed: true,
          updated: ["done"],
          willRepeat: true,
        })
        await expect(tool.execute({ updates: { done: false } }, toolContext(context))).resolves.toEqual({
          changed: true,
          updated: ["done"],
          willRepeat: false,
        })
        return { text: "settled output" }
      },
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Loop initial={{ done: false }} render={({ state }) => <Agent>{String(state.done)}</Agent>} schema={State} />
      )
    ).resolves.toBe("settled output")
    expect(calls).toBe(1)
  })

  it("expires a retained state capability when its Agent finishes", async () => {
    const State = z.object({ done: z.boolean() })
    let retained:
      | {
          context: AgentExecutionContext
          tool: AgentJavaScriptTool
        }
      | undefined
    const provider: AgentProvider = {
      name: "retained",
      async run(request, context) {
        retained = {
          context,
          tool: requireStateTool(request),
        }
        return { text: "finished" }
      },
    }

    await new AmlRuntime({ agentProvider: provider }).evaluate(
      <Loop initial={{ done: false }} render={({ state }) => <Agent>{String(state.done)}</Agent>} schema={State} />
    )

    expect(retained).toBeDefined()
    await expect(retained!.tool.execute({ updates: { done: true } }, toolContext(retained!.context))).rejects.toThrow(
      '"Loop" state capability expired when its Agent finished'
    )
  })

  it("prevents a detached Tool call from committing after its Agent returns", async () => {
    let validationCall = 0
    let releasePatch: (() => void) | undefined
    const State: StandardSchemaV1<{ done: boolean }, { done: boolean }> = {
      "~standard": {
        validate(value: unknown) {
          if (typeof value !== "object" || value === null || typeof Reflect.get(value, "done") !== "boolean") {
            return { issues: [{ message: "done must be boolean" }] }
          }

          const state = {
            done: Reflect.get(value, "done") as boolean,
          }
          validationCall += 1

          // Initial state consumes calls one and two. Hold the patch's first
          // validation until after the provider session has returned.
          if (validationCall === 3) {
            return new Promise<{ value: { done: boolean } }>(resolve => {
              releasePatch = () => resolve({ value: state })
            })
          }

          return { value: state }
        },
        vendor: "detached-test",
        version: 1 as const,
      },
    }
    let detached: Promise<unknown> | undefined
    const provider: AgentProvider = {
      name: "detached",
      async run(request, context) {
        detached = requireStateTool(request).execute({ updates: { done: true } }, toolContext(context))

        // Observe the rejection without joining it; this deliberately models a
        // provider that violates the Tool cleanup barrier.
        void detached.catch(() => undefined)
        return { text: "current output" }
      },
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Loop initial={{ done: false }} render={({ state }) => <Agent>{String(state.done)}</Agent>} schema={State} />
      )
    ).resolves.toBe("current output")
    expect(detached).toBeDefined()
    releasePatch?.()
    await expect(detached).rejects.toThrow('"Loop" state capability expired when its Agent finished')
  })

  it("enforces one evaluation-wide state-transition budget", async () => {
    const State = z.object({ toggle: z.boolean() })
    const provider: AgentProvider = {
      name: "limit",
      async run(request, context) {
        await executeStateTool(request, context, {
          updates: {
            toggle: request.prompt === "false",
          },
        })
        return { text: "stale" }
      },
    }

    await expect(
      new AmlRuntime({
        agentProvider: provider,
        maxStateTransitions: 2,
      }).evaluate(
        <Loop
          initial={{ toggle: false }}
          name="toggle"
          render={({ state }) => <Agent>{String(state.toggle)}</Agent>}
          schema={State}
        />
      )
    ).rejects.toThrow('maxStateTransitions 2 at Loop "toggle" iteration 3')
  })

  it("shares the transition budget across sibling Loops", async () => {
    const State = z.object({ count: z.number().int() })
    const prompts: string[] = []
    const provider: AgentProvider = {
      name: "shared-limit",
      async run(request, context) {
        prompts.push(request.prompt)

        if (request.prompt.endsWith(":0")) {
          await executeStateTool(request, context, {
            updates: { count: 1 },
          })
          return { text: "stale" }
        }

        return { text: "stable" }
      },
    }
    const runtime = new AmlRuntime({
      agentProvider: provider,
      maxStateTransitions: 1,
    })

    await expect(
      runtime.evaluate([
        <Loop
          initial={{ count: 0 }}
          name="first"
          render={({ state }) => <Agent>first:{state.count}</Agent>}
          schema={State}
        />,
        <Loop
          initial={{ count: 0 }}
          name="second"
          render={({ state }) => <Agent>second:{state.count}</Agent>}
          schema={State}
        />,
      ])
    ).rejects.toThrow('maxStateTransitions 1 at Loop "second" iteration 1')
    expect(prompts).toEqual(["first:0", "first:1", "second:0"])
  })

  it("treats a zero state-transition limit as unlimited", async () => {
    const State = z.object({ count: z.number().int() })
    const provider: AgentProvider = {
      name: "unlimited",
      async run(request, context) {
        const count = Number(request.prompt)

        if (count < 3) {
          await executeStateTool(request, context, {
            updates: { count: count + 1 },
          })
          return { text: "stale" }
        }

        return { text: "finished" }
      },
    }

    await expect(
      new AmlRuntime({
        agentProvider: provider,
        maxStateTransitions: 0,
      }).evaluate(<Loop initial={{ count: 0 }} render={({ state }) => <Agent>{state.count}</Agent>} schema={State} />)
    ).resolves.toBe("finished")
  })

  it("selects one Agent through async components and Fragments", async () => {
    const State = z.object({ done: z.boolean() })
    const provider = new DeterministicAgentProvider({
      respond: () => ({ text: "selected" }),
    })

    async function Wrapper() {
      await Promise.resolve()
      const context = await evaluate("resolved")
      return (
        <>
          {null}
          <Agent>{context}</Agent>
          {false}
        </>
      )
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Loop initial={{ done: false }} render={() => <Wrapper />} schema={State} />
      )
    ).resolves.toBe("selected")
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]?.request.prompt).toBe("resolved")
  })

  it("stops Loop wrapper selection immediately after cancellation", async () => {
    const State = z.object({ done: z.boolean() })
    const controller = new AbortController()
    const provider = new DeterministicAgentProvider()
    let laterWrapperRan = false

    async function CancellingWrapper() {
      controller.abort(new Error("stop wrapper selection"))
      await Promise.resolve()
      return null
    }

    function LaterWrapper() {
      laterWrapperRan = true
      return <Agent>must not run</Agent>
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Loop initial={{ done: false }} render={() => [<CancellingWrapper />, <LaterWrapper />]} schema={State} />,
        { signal: controller.signal }
      )
    ).rejects.toThrow("stop wrapper selection")
    expect(laterWrapperRan).toBe(false)
    expect(provider.calls).toHaveLength(0)
  })

  it("rejects invalid outer shapes before any selected Agent runs", async () => {
    const State = z.object({ done: z.boolean() })
    const provider = new DeterministicAgentProvider()
    const runtime = new AmlRuntime({ agentProvider: provider })

    await expect(
      runtime.evaluate(<Loop initial={{ done: false }} render={() => "not an Agent"} schema={State} />)
    ).rejects.toThrow("<Loop> render must resolve to exactly one <Agent>")
    await expect(
      runtime.evaluate(
        <Loop initial={{ done: false }} render={() => [<Agent>one</Agent>, <Agent>two</Agent>]} schema={State} />
      )
    ).rejects.toThrow("<Loop> render must resolve to exactly one <Agent>")
    await expect(
      runtime.evaluate(
        <Loop
          initial={{ done: false }}
          render={() => (
            <Sandbox>
              <Agent>hidden</Agent>
            </Sandbox>
          )}
          schema={State}
        />
      )
    ).rejects.toThrow("<Loop> render must resolve to exactly one <Agent>")
    expect(provider.calls).toHaveLength(0)
  })

  it("reserves the runtime Tool name while bypassing author allowlists", async () => {
    const State = z.object({ done: z.boolean() })
    const provider = new DeterministicAgentProvider({
      respond(request) {
        expect(request.tools.map(tool => tool.name)).toEqual(["aml_set_state"])
        return { text: "available" }
      },
    })

    await expect(
      new AmlRuntime({
        agentProvider: provider,
        allowedTools: [],
      }).evaluate(<Loop initial={{ done: false }} render={() => <Agent>run</Agent>} schema={State} />)
    ).resolves.toBe("available")

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Loop
          initial={{ done: false }}
          render={() => (
            <Agent>
              <Tool name="aml_set_state" />
              duplicate
            </Agent>
          )}
          schema={State}
        />
      )
    ).rejects.toThrow('Agent declares duplicate Tool "aml_set_state"')
  })

  it("rejects non-JSON and unstable schema state before an Agent runs", async () => {
    const provider = new DeterministicAgentProvider()
    const runtime = new AmlRuntime({ agentProvider: provider })
    const DateState = z.object({ createdAt: z.any() })
    const unstableSchema = {
      "~standard": {
        validate(value: unknown) {
          const count = Number(Reflect.get(value as object, "count"))
          return { value: { count: count + 1 } }
        },
        vendor: "unstable-test",
        version: 1 as const,
      },
    }

    await expect(
      runtime.evaluate(
        <Loop initial={{ createdAt: new Date("2026-01-01") }} render={() => <Agent>never</Agent>} schema={DateState} />
      )
    ).rejects.toThrow("must contain only stable JSON")
    await expect(
      runtime.evaluate(<Loop initial={{ count: 0 }} render={() => <Agent>never</Agent>} schema={unstableSchema} />)
    ).rejects.toThrow("schema must produce stable JSON state")
    expect(provider.calls).toHaveLength(0)
  })

  it("accepts stable schema normalization before rendering", async () => {
    const State = z.object({
      label: z.string().trim(),
    })
    const initial = {
      ignored: true,
      label: " ready ",
    }
    const provider = new DeterministicAgentProvider({
      respond: request => ({ text: request.prompt }),
    })

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Loop initial={initial} render={({ state }) => <Agent>{state.label}</Agent>} schema={State} />
      )
    ).resolves.toBe("ready")
    expect(provider.calls[0]?.request.prompt).toBe("ready")
  })

  it("isolates state capabilities across concurrent evaluations", async () => {
    const State = z.object({
      done: z.boolean(),
      user: z.string(),
    })
    const provider: AgentProvider = {
      name: "parallel",
      async run(request, context) {
        if (request.prompt.endsWith(":pending")) {
          const user = request.prompt.split(":")[0]!
          await executeStateTool(request, context, {
            updates: { done: true, user },
          })
          return { text: "stale" }
        }

        return { text: request.prompt }
      },
    }

    function Workflow({ user }: { user: string }) {
      return (
        <Loop
          initial={{ done: false, user: "" }}
          render={({ state }) => <Agent>{state.done ? state.user : `${user}:pending`}</Agent>}
          schema={State}
        />
      )
    }

    await expect(
      Promise.all([
        new AmlRuntime({ agentProvider: provider }).evaluate(<Workflow user="alpha" />),
        new AmlRuntime({ agentProvider: provider }).evaluate(<Workflow user="beta" />),
      ])
    ).resolves.toEqual(["alpha", "beta"])
  })

  it("exposes generic immutable render types", () => {
    const State = z.object({
      nested: z.object({
        values: z.array(z.string()),
      }),
      tuple: z.tuple([z.string(), z.number()]),
    })
    type Props = LoopProps<typeof State>
    type RenderState = Parameters<Props["render"]>[0]["state"]

    expectTypeOf<RenderState>().toEqualTypeOf<DeepReadonly<z.output<typeof State>>>()
    expectTypeOf<RenderState["tuple"]>().toEqualTypeOf<readonly [string, number]>()
  })

  it("normalizes a wider schema input into rendered canonical state", async () => {
    const NormalizedState = z
      .object({
        count: z.union([z.string(), z.number()]),
      })
      .transform(({ count }) => ({ count: Number(count) }))
    type Props = LoopProps<typeof NormalizedState>
    type RenderState = Parameters<Props["render"]>[0]["state"]

    expectTypeOf<Props["initial"]>().toEqualTypeOf<{
      count: string | number
    }>()
    expectTypeOf<RenderState>().toEqualTypeOf<Readonly<{ count: number }>>()

    await expect(
      new AmlRuntime({
        agentProvider: new DeterministicAgentProvider({
          respond: request => ({ text: request.prompt }),
        }),
      }).evaluate(
        <Loop initial={{ count: "7" }} render={({ state }) => <Agent>{state.count}</Agent>} schema={NormalizedState} />
      )
    ).resolves.toBe("7")

    const DisjointState = z.object({ count: z.string() }).transform(({ count }) => ({ count: Number(count) }))
    type DisjointProps = LoopProps<typeof DisjointState>

    expectTypeOf<DisjointProps["schema"]>().toEqualTypeOf<never>()

    if (false) {
      // The component call must retain the exact schema instead of widening it
      // to the generic constraint and accepting incompatible canonical state.
      Loop({
        initial: { count: "7" },
        render: ({ state }) => <Agent>{String(state)}</Agent>,
        // @ts-expect-error disjoint output cannot be fed back into this input
        schema: DisjointState,
      })
    }
  })

  it("rejects invalid Loop options at their owning boundary", async () => {
    const State = z.object({ done: z.boolean() })
    const provider = new DeterministicAgentProvider()

    expect(
      () =>
        new AmlRuntime({
          maxStateTransitions: -1,
        })
    ).toThrow("maxStateTransitions must be a non-negative safe integer")
    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Loop initial={{ done: false }} name=" invalid " render={() => <Agent>never</Agent>} schema={State} />
      )
    ).rejects.toThrow("<Loop> name must be a non-empty normalized string")
    expect(provider.calls).toHaveLength(0)
  })
})

/**
 * Returns the one runtime-owned state capability from an Agent request.
 */
function requireStateTool(request: AgentRequest): AgentJavaScriptTool {
  const tool = request.tools.find(
    (candidate): candidate is AgentJavaScriptTool =>
      candidate.kind === "javascript" && candidate.name === "aml_set_state"
  )

  if (!tool) {
    throw new Error("Missing aml_set_state Tool")
  }

  return tool
}

/**
 * Narrows an Agent context to the provider-neutral Tool execution contract.
 */
function toolContext(context: AgentExecutionContext): {
  readonly signal: AbortSignal
  readonly trace: AgentExecutionContext["trace"]
} {
  return Object.freeze({
    signal: context.signal,
    trace: context.trace,
  })
}

/**
 * Executes the runtime state Tool as a deterministic provider would.
 */
async function executeStateTool(request: AgentRequest, context: AgentExecutionContext, input: unknown): Promise<void> {
  await requireStateTool(request).execute(input, toolContext(context))
}
