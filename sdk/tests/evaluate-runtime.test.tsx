import { z } from "zod"
import { describe, expect, expectTypeOf, it, vi } from "vitest"

import { Agent } from "../src/components/agent/agent.js"
import type { AgentProvider } from "../src/components/agent/agent-provider.js"
import { FollowUp } from "../src/components/follow-up/follow-up.js"
import { Loop } from "../src/components/loop/loop.js"
import { Sandbox } from "../src/components/sandbox/sandbox.js"
import { Skill } from "../src/components/skill/skill.js"
import { System } from "../src/components/system/system.js"
import { Workspace } from "../src/components/workspace/workspace.js"
import type { AmlRenderable } from "../src/core/aml-node.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { evaluate } from "../src/core/evaluate.js"
import { DeterministicAgentProvider } from "../src/testing/deterministic-agent-provider.js"
import { DeterministicSandboxProvider } from "../src/testing/deterministic-sandbox-provider.js"
import { DeterministicWorkspaceProvider } from "../src/testing/deterministic-workspace-provider.js"

const ResearchResult = z.object({
  risks: z.array(z.string()),
  summary: z.string(),
})

describe("component-local evaluate()", () => {
  it("returns typed structured data without suspending or rerendering", async () => {
    const events: string[] = []
    const provider = new DeterministicAgentProvider({
      respond(request, _context, callIndex) {
        events.push(`agent:${callIndex}`)

        if (callIndex === 0) {
          expect(request.output?.type).toBe("json")
          expect(request.output?.jsonSchema).toMatchObject({
            properties: {
              risks: { type: "array" },
              summary: { type: "string" },
            },
            type: "object",
          })
          expect(Object.isFrozen(request.output?.jsonSchema)).toBe(true)

          return {
            structured: {
              risks: ["stale dependency"],
              summary: "one finding",
            },
            text: "",
          }
        }

        expect(request.output).toBeUndefined()
        expect(request.prompt).toBe("Synthesize: one finding")
        return { text: "final" }
      },
    })
    let renders = 0

    async function Workflow() {
      renders += 1
      events.push("component:start")
      const research = await evaluate(<Agent>Research.</Agent>, ResearchResult)
      expectTypeOf(research).toEqualTypeOf<{
        risks: string[]
        summary: string
      }>()
      events.push(`component:data:${research.risks[0]}`)

      return <Agent>Synthesize: {research.summary}</Agent>
    }

    await expect(new AmlRuntime({ agentProvider: provider }).evaluate(<Workflow />)).resolves.toBe("final")
    expect(renders).toBe(1)
    expect(events).toEqual(["component:start", "agent:0", "component:data:stale dependency", "agent:1"])
    expect(provider.calls[0]?.context.trace.runId).toBe(provider.calls[1]?.context.trace.runId)
  })

  it("returns text through the same evaluation domain", async () => {
    const provider = new DeterministicAgentProvider({
      respond: request => ({ text: `answer:${request.prompt}` }),
    })

    async function Workflow() {
      const result = await evaluate(<Agent>inspect</Agent>)
      expectTypeOf(result).toEqualTypeOf<string>()
      return `received:${result}`
    }

    await expect(new AmlRuntime({ agentProvider: provider }).evaluate(<Workflow />)).resolves.toBe(
      "received:answer:inspect"
    )
  })

  it("shares Agent-call limits with the root evaluation", async () => {
    const provider = new DeterministicAgentProvider()

    async function Workflow() {
      await evaluate(<Agent>first</Agent>)
      return <Agent>second</Agent>
    }

    await expect(
      new AmlRuntime({
        agentProvider: provider,
        maxAgentCalls: 1,
      }).evaluate(<Workflow />)
    ).rejects.toThrow("exceeded maxAgentCalls 1")
    expect(provider.calls).toHaveLength(1)
  })

  it("shares maxDepth accounting with the root evaluation", async () => {
    function Workflow() {
      return evaluate(<Agent>too deep</Agent>)
    }

    await expect(new AmlRuntime({ maxDepth: 1 }).evaluate(<Workflow />)).rejects.toThrow(
      "AML evaluation exceeded maxDepth 1"
    )
  })

  it("inherits the active Sandbox into a nested Agent call", async () => {
    const sandboxProvider = new DeterministicSandboxProvider()
    const agentProvider: AgentProvider = {
      name: "sandbox-aware",
      run(request, context) {
        expect(context.sandbox?.provider.name).toBe("deterministic-sandbox")
        expect(context.sandbox?.root).toBe("repository")
        return Promise.resolve({ text: request.prompt })
      },
      supportsSandbox: () => true,
    }

    async function Workflow() {
      const nested = await evaluate(<Agent>inside</Agent>)
      return `observed:${nested}`
    }

    await expect(
      new AmlRuntime({ agentProvider }).evaluate(
        <Sandbox provider={sandboxProvider} root="repository">
          <Workflow />
        </Sandbox>
      )
    ).resolves.toBe("observed:inside")
    expect(sandboxProvider.releases).toHaveLength(1)
  })

  it("inherits the active Workspace into component-local work", async () => {
    const workspaceProvider = new DeterministicWorkspaceProvider()
    const sandboxProvider = new DeterministicSandboxProvider({
      createHandle(request) {
        expect(request.workspace).toMatchObject({
          directory: "/deterministic-workspace",
          workspaceId: "review-42",
        })
        return { workspace: request.workspace }
      },
    })

    async function Workflow() {
      return await evaluate(<Sandbox provider={sandboxProvider}>nested</Sandbox>)
    }

    await expect(
      new AmlRuntime().evaluate(
        <Workspace id="review-42" provider={workspaceProvider}>
          <Workflow />
        </Workspace>
      )
    ).resolves.toBe("nested")
    expect(workspaceProvider.acquisitions).toHaveLength(1)
    expect(workspaceProvider.saves).toHaveLength(1)
    expect(workspaceProvider.releases).toHaveLength(1)
    expect(sandboxProvider.releases).toHaveLength(1)
  })

  it("joins concurrent nested work before releasing an inherited Sandbox", async () => {
    let finishSecond: (() => void) | undefined
    const secondGate = new Promise<void>(resolve => {
      finishSecond = resolve
    })
    const events: string[] = []
    const agentProvider = new DeterministicAgentProvider({
      async respond(request) {
        events.push(`${request.prompt}:start`)

        if (request.prompt === "first") {
          throw new Error("first failed")
        }

        await secondGate
        events.push("second:end")
        return { text: "second" }
      },
      supportsSandbox: () => true,
    })
    const sandboxProvider = new DeterministicSandboxProvider()

    async function Workflow() {
      await Promise.all([evaluate(<Agent>first</Agent>), evaluate(<Agent>second</Agent>)])
      return "unreachable"
    }

    const evaluation = new AmlRuntime({ agentProvider }).evaluate(
      <Sandbox provider={sandboxProvider}>
        <Workflow />
      </Sandbox>
    )

    await vi.waitFor(() => {
      expect(events).toEqual(["first:start", "second:start"])
    })
    expect(sandboxProvider.releases).toHaveLength(0)

    finishSecond?.()
    await expect(evaluation).rejects.toThrow('Agent "deterministic" (span-2) failed')
    expect(events).toEqual(["first:start", "second:start", "second:end"])
    expect(sandboxProvider.releases).toHaveLength(1)
  })

  it("rejects calls outside a component and after its invocation settles", async () => {
    expect(() => evaluate("outside")).toThrow("evaluate() is only available while an AML component is active")

    let callAfterReturn: (() => Promise<string>) | undefined

    function Workflow() {
      callAfterReturn = () => evaluate("detached")
      return "done"
    }

    await expect(new AmlRuntime().evaluate(<Workflow />)).resolves.toBe("done")
    expect(() => callAfterReturn?.()).toThrow("evaluate() is only available while an AML component is active")
  })

  it("revokes async-local access inherited by detached work", async () => {
    let releaseDetached: (() => void) | undefined
    let detached: Promise<unknown> | undefined

    function Workflow() {
      const gate = new Promise<void>(resolve => {
        releaseDetached = resolve
      })

      // This task inherits AsyncLocalStorage while the component is active but
      // does not participate in the component's returned completion promise.
      detached = gate.then(() => evaluate("too late"))
      return "done"
    }

    await expect(new AmlRuntime().evaluate(<Workflow />)).resolves.toBe("done")
    releaseDetached?.()
    await expect(detached).rejects.toThrow("evaluate() is only available while an AML component is active")
  })

  it("revokes synchronous components before detached microtasks run", async () => {
    let detached: Promise<unknown> | undefined

    function Workflow() {
      detached = Promise.resolve().then(() => evaluate("too late"))
      return "done"
    }

    await expect(new AmlRuntime().evaluate(<Workflow />)).resolves.toBe("done")
    await expect(detached).rejects.toThrow("evaluate() is only available while an AML component is active")
  })

  it("keeps component-local evaluation active for returned thenables", async () => {
    function Workflow() {
      const lazy: PromiseLike<AmlRenderable> = {
        then(onfulfilled, onrejected) {
          return evaluate("lazy").then(onfulfilled, onrejected)
        },
      }

      return lazy
    }

    await expect(new AmlRuntime().evaluate(<Workflow />)).resolves.toBe("lazy")
  })

  it("reads a returned thenable getter once inside the component boundary", async () => {
    let reads = 0

    function Workflow() {
      const lazy: PromiseLike<AmlRenderable> = {
        get then(): PromiseLike<AmlRenderable>["then"] {
          reads += 1
          const nested: Promise<AmlRenderable> = evaluate("getter")
          return nested.then.bind(nested)
        },
      }

      return lazy
    }

    await expect(new AmlRuntime().evaluate(<Workflow />)).resolves.toBe("getter")
    expect(reads).toBe(1)
  })

  it("preserves cycle detection across component-local evaluation", async () => {
    async function Recursive() {
      return await evaluate(recursiveNode)
    }

    const recursiveNode: AmlRenderable = <Recursive />

    await expect(new AmlRuntime({ maxDepth: 0 }).evaluate(recursiveNode)).rejects.toThrow(
      "AML nodes cannot contain cycles"
    )
  })

  it("rejects missing and invalid provider structured output", async () => {
    const missing = new DeterministicAgentProvider({
      respond: () => ({ text: "" }),
    })
    const invalid = new DeterministicAgentProvider({
      respond: () => ({
        structured: { risks: "not-an-array", summary: "bad" },
        text: "",
      }),
    })

    async function Structured({ provider }: { provider: AgentProvider }) {
      await evaluate(<Agent provider={provider}>extract</Agent>, ResearchResult)
      return "unreachable"
    }

    await expect(new AmlRuntime().evaluate(<Structured provider={missing} />)).rejects.toThrow(
      "omitted structured output"
    )
    await expect(new AmlRuntime().evaluate(<Structured provider={invalid} />)).rejects.toThrow(
      "returned invalid structured output"
    )
  })

  it("rejects non-JSON provider data before permissive schema validation", async () => {
    const provider = new DeterministicAgentProvider({
      respond: () => ({
        // z.any() deliberately accepts this value. AML still rejects it at the
        // provider transport boundary because structured model data is JSON.
        structured: () => "not portable",
        text: "",
      }),
    })

    async function Workflow() {
      await evaluate(<Agent provider={provider}>extract</Agent>, z.any())
      return "unreachable"
    }

    const error = await new AmlRuntime().evaluate(<Workflow />).catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      cause: {
        cause: {
          message: "Agent structured output contains unsupported function data",
        },
        message: "Agent structured output is not valid JSON",
      },
      message: 'Agent "deterministic" (span-1) returned invalid structured output',
    })
  })

  it("requires exactly one Agent and no adjacent text", async () => {
    const provider = new DeterministicAgentProvider({
      respond: () => ({
        structured: { risks: [], summary: "valid" },
        text: "",
      }),
    })

    async function NoAgent() {
      await evaluate("plain text", ResearchResult)
      return "unreachable"
    }

    async function TwoAgents() {
      await evaluate([<Agent provider={provider}>one</Agent>, <Agent provider={provider}>two</Agent>], ResearchResult)
      return "unreachable"
    }

    async function AdjacentText() {
      await evaluate([<Agent provider={provider}>one</Agent>, "extra"], ResearchResult)
      return "unreachable"
    }

    await expect(new AmlRuntime().evaluate(<NoAgent />)).rejects.toThrow("cannot include text outside its <Agent>")
    await expect(new AmlRuntime().evaluate(<TwoAgents />)).rejects.toThrow("must resolve to exactly one <Agent>")
    await expect(new AmlRuntime().evaluate(<AdjacentText />)).rejects.toThrow("cannot include text outside its <Agent>")
  })

  it("rejects nested Loops in every structured Agent message channel", async () => {
    const State = z.object({ done: z.boolean() })
    const provider = new DeterministicAgentProvider({
      respond: () => ({
        structured: { risks: [], summary: "unreachable" },
        text: "",
      }),
    })
    const nestedLoops: AmlRenderable[] = [
      <Agent provider={provider}>
        <Loop initial={{ done: false }} render={() => <Agent provider={provider}>prompt</Agent>} schema={State} />
      </Agent>,
      <Agent provider={provider}>
        <System>
          <Loop initial={{ done: false }} render={() => <Agent provider={provider}>system</Agent>} schema={State} />
        </System>
        prompt
      </Agent>,
      <Agent provider={provider}>
        <Skill>
          <Loop initial={{ done: false }} render={() => <Agent provider={provider}>skill</Agent>} schema={State} />
        </Skill>
        prompt
      </Agent>,
      <Agent provider={provider}>
        prompt
        <FollowUp>
          <Loop initial={{ done: false }} render={() => <Agent provider={provider}>follow-up</Agent>} schema={State} />
        </FollowUp>
      </Agent>,
    ]

    for (const value of nestedLoops) {
      async function Workflow() {
        await evaluate(value, ResearchResult)
        return "unreachable"
      }

      await expect(new AmlRuntime().evaluate(<Workflow />)).rejects.toThrow(
        "Structured evaluate() must resolve to exactly one <Agent>"
      )
    }

    // No provider call may escape the schema-bearing evaluate() boundary.
    expect(provider.calls).toHaveLength(0)
  })

  it("returns Standard Schema transformations rather than raw provider data", async () => {
    const LengthResult = z.object({ summary: z.string() }).transform(value => value.summary.length)
    const provider = new DeterministicAgentProvider({
      respond: () => ({
        structured: { summary: "four" },
        text: "",
      }),
    })

    async function Workflow() {
      const length = await evaluate(<Agent provider={provider}>measure</Agent>, LengthResult)
      expectTypeOf(length).toEqualTypeOf<number>()
      return `length:${length}`
    }

    await expect(new AmlRuntime().evaluate(<Workflow />)).resolves.toBe("length:4")
  })
})
