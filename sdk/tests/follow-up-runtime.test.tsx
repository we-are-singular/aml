import { describe, expect, expectTypeOf, it } from "vitest"
import { z } from "zod"

import { Agent } from "../src/components/agent/agent.js"
import type { AgentProvider } from "../src/components/agent/agent-provider.js"
import { FollowUp, type FollowUpProps } from "../src/components/follow-up/follow-up.js"
import { defineMcpServer } from "../src/components/mcp/define-mcp-server.js"
import { Mcp } from "../src/components/mcp/mcp.js"
import { Sandbox } from "../src/components/sandbox/sandbox.js"
import { Skill } from "../src/components/skill/skill.js"
import { System } from "../src/components/system/system.js"
import { Tool } from "../src/components/tool/tool.js"
import { defineTool } from "../src/components/tool/define-tool.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { evaluate } from "../src/core/evaluate.js"
import { DeterministicAgentProvider } from "../src/testing/deterministic-agent-provider.js"
import { DeterministicSandboxProvider } from "../src/testing/deterministic-sandbox-provider.js"

describe("FollowUp", () => {
  it("assembles one frozen ordered session plan with shared capabilities", async () => {
    const turns: string[] = []
    const read = defineTool({
      description: "Read fixture data",
      input: z.object({}),
      name: "read",
      execute: async () => "fixture",
    })
    const project = defineMcpServer({
      name: "project",
      transport: {
        type: "streamable-http",
        url: "https://example.com/mcp",
      },
    })
    const provider: AgentProvider = {
      name: "multi-turn",
      async run(request) {
        expect(request.followUps).toEqual(["Challenge the findings.", "Produce the final review."])
        expect(Object.isFrozen(request.followUps)).toBe(true)
        expect(request.tools.map(tool => tool.name)).toEqual(["read"])
        expect(request.mcpServers).toEqual([{ definition: project, kind: "configured" }])

        // A provider owns session history. This deterministic adapter records
        // the exact user inputs it would send through that one session.
        turns.push(request.prompt, ...(request.followUps ?? []))
        return { text: "final review" }
      },
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          <Tool use={read} />
          <Mcp use={project} />
          Investigate the implementation.
          <FollowUp> Challenge the findings. </FollowUp>
          <FollowUp> Produce the final review. </FollowUp>
        </Agent>
      )
    ).resolves.toBe("final review")
    expect(turns).toEqual(["Investigate the implementation.", "Challenge the findings.", "Produce the final review."])
  })

  it("accepts flat FollowUps returned by components and Fragments", async () => {
    const provider = new DeterministicAgentProvider({
      respond(request) {
        return {
          text: [request.prompt, ...(request.followUps ?? [])].join("|"),
        }
      },
    })

    function LaterTurns() {
      return (
        <>
          <FollowUp>second</FollowUp>
          {"\n"}
          <FollowUp>third</FollowUp>
        </>
      )
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          first
          <LaterTurns />
        </Agent>
      )
    ).resolves.toBe("first|second|third")
  })

  it("resolves Skills and child Agents into a FollowUp before the parent session", async () => {
    const calls: string[] = []
    const child = new DeterministicAgentProvider({
      name: "child",
      respond(request) {
        calls.push(`child:${request.prompt}`)
        return { text: "child evidence" }
      },
    })
    const parent = new DeterministicAgentProvider({
      name: "parent",
      respond(request) {
        calls.push(`parent:${request.prompt}`)
        expect(request.followUps).toEqual([
          ["Skill: adversarial", "", "Prefer counterexamples.", "Use child evidence."].join("\n"),
        ])
        return { text: "done" }
      },
    })

    await expect(
      new AmlRuntime({ agentProvider: parent }).evaluate(
        <Agent>
          Inspect the change.
          <FollowUp>
            <Skill name="adversarial">Prefer counterexamples.</Skill>
            {"\n"}
            Use <Agent provider={child}>find evidence</Agent>.
          </FollowUp>
        </Agent>
      )
    ).resolves.toBe("done")
    expect(calls).toEqual(["child:find evidence", "parent:Inspect the change."])
  })

  it("applies structured output to the complete multi-turn request", async () => {
    const Result = z.object({ verdict: z.string() })
    const provider: AgentProvider = {
      name: "structured-follow-up",
      async run(request) {
        expect(request.prompt).toBe("Research the change.")
        expect(request.followUps).toEqual(["Return the final structured verdict."])
        expect(request.output?.type).toBe("json")
        return {
          structured: { verdict: "approve" },
          text: "",
        }
      },
    }

    async function Workflow() {
      const result = await evaluate(
        <Agent provider={provider}>
          Research the change.
          <FollowUp>Return the final structured verdict.</FollowUp>
        </Agent>,
        Result
      )

      return result.verdict
    }

    await expect(new AmlRuntime().evaluate(<Workflow />)).resolves.toBe("approve")
  })

  it("rejects invalid placement, nesting, and message content", async () => {
    const provider = new DeterministicAgentProvider()
    const runtime = new AmlRuntime({ agentProvider: provider })

    await expect(runtime.evaluate(<FollowUp>outside</FollowUp>)).rejects.toThrow(
      "<FollowUp> is only valid inside <Agent>"
    )
    await expect(
      runtime.evaluate(
        <Agent>
          initial
          <FollowUp>
            nested
            <FollowUp>invalid</FollowUp>
          </FollowUp>
        </Agent>
      )
    ).rejects.toThrow("nested <FollowUp> descriptors are invalid")
    await expect(
      runtime.evaluate(
        <Agent>
          initial
          <FollowUp> </FollowUp>
        </Agent>
      )
    ).rejects.toThrow("<FollowUp> must resolve to non-empty text")
    await expect(
      runtime.evaluate(
        <Agent>
          initial
          <FollowUp>later</FollowUp>
          invalid trailing input
        </Agent>
      )
    ).rejects.toThrow("non-whitespace Agent text cannot follow <FollowUp>")
    await expect(
      runtime.evaluate(
        <Agent>
          initial
          <System>
            <FollowUp>invalid channel</FollowUp>
          </System>
        </Agent>
      )
    ).rejects.toThrow("<FollowUp> is only valid inside <Agent>")
    expect(provider.calls).toHaveLength(0)
  })

  it("rejects turn-specific Tool and MCP capability grants", async () => {
    const provider = new DeterministicAgentProvider()
    const runtime = new AmlRuntime({ agentProvider: provider })
    const read = defineTool({
      description: "Read fixture data",
      input: z.object({}),
      name: "read",
      execute: async () => "fixture",
    })

    await expect(
      runtime.evaluate(
        <Agent>
          initial
          <FollowUp>
            <Tool use={read} />
            later
          </FollowUp>
        </Agent>
      )
    ).rejects.toThrow("<Tool> is invalid inside <FollowUp>")
    await expect(
      runtime.evaluate(
        <Agent>
          initial
          <FollowUp>
            <Mcp name="project" />
            later
          </FollowUp>
        </Agent>
      )
    ).rejects.toThrow("<Mcp> is invalid inside <FollowUp>")
    expect(provider.calls).toHaveLength(0)
  })

  it("rejects a FollowUp hidden beneath a lexical Sandbox wrapper", async () => {
    const agentProvider = new DeterministicAgentProvider()
    const sandboxProvider = new DeterministicSandboxProvider()

    await expect(
      new AmlRuntime({ agentProvider }).evaluate(
        <Agent>
          initial
          <Sandbox provider={sandboxProvider}>
            <FollowUp>not immediate</FollowUp>
          </Sandbox>
        </Agent>
      )
    ).rejects.toThrow("<FollowUp> must be an immediate message descriptor of <Agent>")
    expect(agentProvider.calls).toHaveLength(0)
    expect(sandboxProvider.acquisitions).toHaveLength(1)
    expect(sandboxProvider.releases).toEqual(["deterministic-sandbox-1"])
  })

  it("enforces authored turn limits without counting a FollowUp as another Agent", async () => {
    const provider = new DeterministicAgentProvider({
      respond: () => ({ text: "done" }),
    })
    const followUps = Array.from({ length: 16 }, (_, index) => <FollowUp>turn-{index + 2}</FollowUp>)

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          turn-1
          {followUps}
        </Agent>
      )
    ).rejects.toThrow("Agent span-1 exceeded maxTurnsPerAgent 16")
    expect(provider.calls).toHaveLength(0)

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          turn-1
          {followUps.slice(0, 15)}
        </Agent>
      )
    ).resolves.toBe("done")
    expect(provider.calls).toHaveLength(1)

    await expect(
      new AmlRuntime({
        agentProvider: provider,
        maxAgentCalls: 1,
        maxTurnsPerAgent: 0,
      }).evaluate(
        <Agent>
          turn-1
          {followUps}
        </Agent>
      )
    ).resolves.toBe("done")
    expect(provider.calls).toHaveLength(2)
  })

  it("recognizes a FollowUp marker from another SDK copy", async () => {
    const provider = new DeterministicAgentProvider({
      respond(request) {
        return {
          text: [request.prompt, ...(request.followUps ?? [])].join("|"),
        }
      },
    })
    const nodeBrand = Symbol.for("@aml-jsx/sdk/node")
    const primitiveKind = Symbol.for("@aml-jsx/sdk/primitive-kind")

    function ForeignFollowUp(): never {
      throw new Error("Foreign FollowUp was invoked as a component")
    }

    Object.defineProperty(ForeignFollowUp, primitiveKind, {
      value: "follow-up",
    })
    const followUpNode = {
      $$typeof: nodeBrand,
      props: { children: "later" },
      type: ForeignFollowUp,
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          initial
          {followUpNode}
        </Agent>
      )
    ).resolves.toBe("initial|later")
  })

  it("exposes the public FollowUp prop contract", () => {
    expectTypeOf<Parameters<typeof FollowUp>[0]>().toEqualTypeOf<FollowUpProps>()
  })
})

describe("FollowUp runtime options", () => {
  it("rejects invalid authored turn limits", () => {
    expect(() => new AmlRuntime({ maxTurnsPerAgent: -1 })).toThrow(
      "maxTurnsPerAgent must be a non-negative safe integer"
    )
    expect(() => new AmlRuntime({ maxTurnsPerAgent: 1.5 })).toThrow(
      "maxTurnsPerAgent must be a non-negative safe integer"
    )
  })
})
