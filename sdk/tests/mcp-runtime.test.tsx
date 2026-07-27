import { describe, expect, expectTypeOf, it, vi } from "vitest"

import { Agent } from "../src/components/agent/agent.js"
import type { AgentMcpServer } from "../src/components/mcp/aml-mcp-server.js"
import { defineMcpServer } from "../src/components/mcp/define-mcp-server.js"
import { Mcp } from "../src/components/mcp/mcp.js"
import { System } from "../src/components/system/system.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { DeterministicAgentProvider } from "../src/testing/deterministic-agent-provider.js"

describe("defineMcpServer()", () => {
  it("snapshots and freezes standard transport definitions", () => {
    const args = ["server.mjs"]
    const env = { TOKEN: "secret" }
    const local = defineMcpServer({
      name: "project",
      transport: {
        args,
        command: "node",
        cwd: "/workspace",
        env,
        type: "stdio",
      },
    })
    const headers = { Authorization: "Bearer secret" }
    const remote = defineMcpServer({
      name: "github",
      transport: {
        headers,
        type: "streamable-http",
        url: new URL("https://example.com/mcp"),
      },
    })

    args.push("--mutated")
    env.TOKEN = "mutated"
    headers.Authorization = "mutated"

    expect(local).toEqual({
      name: "project",
      transport: {
        args: ["server.mjs"],
        command: "node",
        cwd: "/workspace",
        env: { TOKEN: "secret" },
        type: "stdio",
      },
    })
    expect(remote).toEqual({
      name: "github",
      transport: {
        headers: { Authorization: "Bearer secret" },
        type: "streamable-http",
        url: "https://example.com/mcp",
      },
    })
    expect(Object.isFrozen(local)).toBe(true)
    expect(Object.isFrozen(local.transport)).toBe(true)
    expect(local.__amlMcpServer).toBe(true)
    expect(Object.keys(local)).not.toContain("__amlMcpServer")
    expect(
      Object.isFrozen(
        local.transport.type === "stdio"
          ? local.transport.args
          : undefined,
      ),
    ).toBe(true)
    expectTypeOf(local).toMatchTypeOf<Readonly<{
      name: string
      transport: unknown
    }>>()
  })

  it("captures authority-bearing definition getters exactly once", () => {
    let nameReads = 0
    let transportReads = 0
    const definition = {
      get name() {
        nameReads += 1
        return nameReads === 1 ? "stable" : "changed"
      },
      get transport() {
        transportReads += 1
        return {
          command: "node",
          type: "stdio" as const,
        }
      },
    }

    expect(defineMcpServer(definition).name).toBe("stable")
    expect(nameReads).toBe(1)
    expect(transportReads).toBe(1)

    let argumentReads = 0
    const args = ["safe"]
    Object.defineProperty(args, 0, {
      enumerable: true,
      get() {
        argumentReads += 1
        return argumentReads === 1 ? "safe" : 42
      },
    })
    const server = defineMcpServer({
      name: "stateful-args",
      transport: {
        args,
        command: "node",
        type: "stdio",
      },
    })

    expect(server.transport).toMatchObject({ args: ["safe"] })
    expect(argumentReads).toBe(1)
  })

  it("rejects malformed names and transport fields synchronously", () => {
    expect(() =>
      defineMcpServer({
        name: " project",
        transport: { command: "node", type: "stdio" },
      }),
    ).toThrow("MCP server name must be a non-empty normalized string")
    expect(() =>
      defineMcpServer({
        name: "project",
        transport: { command: "", type: "stdio" },
      }),
    ).toThrow("MCP stdio command must be a non-empty normalized string")
    expect(() =>
      defineMcpServer({
        name: "project",
        transport: {
          args: ["valid", 42] as never,
          command: "node",
          type: "stdio",
        },
      }),
    ).toThrow("MCP stdio args must be an array of strings")
    expect(() =>
      defineMcpServer({
        name: "project",
        transport: {
          type: "streamable-http",
          url: "file:///tmp/server",
        },
      }),
    ).toThrow("must use http or https")
  })
})

describe("Mcp", () => {
  it("collects named and configured servers without adding prompt text", async () => {
    const configured = defineMcpServer({
      name: "project",
      transport: {
        type: "streamable-http",
        url: "https://example.com/mcp",
      },
    })
    const provider = new DeterministicAgentProvider({
      respond(request) {
        expect(request.prompt).toBe("Investigate.")
        expect(request.mcpServers).toEqual([
          { kind: "named", name: "github" },
          {
            definition: configured,
            kind: "configured",
          },
        ] satisfies readonly AgentMcpServer[])
        expect(Object.isFrozen(request.mcpServers)).toBe(true)
        return { text: "done" }
      },
    })

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          <Mcp name="github" />
          <Mcp use={configured} />
          Investigate.
        </Agent>,
      ),
    ).resolves.toBe("done")
  })

  it("scopes grants to the nearest Agent", async () => {
    const child = new DeterministicAgentProvider({
      respond(request) {
        expect(request.mcpServers).toEqual([
          { kind: "named", name: "child" },
        ])
        return { text: "child output" }
      },
    })
    const parent = new DeterministicAgentProvider({
      respond(request) {
        expect(request.mcpServers).toEqual([
          { kind: "named", name: "parent" },
        ])
        expect(request.prompt).toBe("child outputparent prompt")
        return { text: "done" }
      },
    })

    await expect(
      new AmlRuntime().evaluate(
        <Agent provider={parent}>
          <Agent provider={child}>
            <Mcp name="child" />
            child prompt
          </Agent>
          <Mcp name="parent" />
          parent prompt
        </Agent>,
      ),
    ).resolves.toBe("done")
  })

  it("rejects invalid placement, shape, duplicates, and disallowed names", async () => {
    const provider = new DeterministicAgentProvider()
    const McpWithChildren = Mcp as unknown as (
      props: Readonly<{ children: string; name: string }>,
    ) => never

    await expect(
      new AmlRuntime().evaluate(<Mcp name="github" />),
    ).rejects.toThrow("<Mcp> is only valid inside <Agent>")
    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          <System>
            <Mcp name="github" />
          </System>
          prompt
        </Agent>,
      ),
    ).rejects.toThrow("<Mcp> is only valid inside <Agent>")
    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          <McpWithChildren name="github">invalid</McpWithChildren>
          prompt
        </Agent>,
      ),
    ).rejects.toThrow("<Mcp> does not accept children")
    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          <Mcp name="github" />
          <Mcp name="github" />
          prompt
        </Agent>,
      ),
    ).rejects.toThrow('Agent declares duplicate MCP server "github"')
    await expect(
      new AmlRuntime({
        agentProvider: provider,
        allowedMcpServers: ["project"],
      }).evaluate(
        <Agent>
          <Mcp name="github" />
          prompt
        </Agent>,
      ),
    ).rejects.toThrow(
      'MCP server "github" is not allowed by this runtime',
    )
    expect(provider.calls).toHaveLength(0)
  })

  it("rejects structural, cloned, and proxied server lookalikes", async () => {
    const provider = new DeterministicAgentProvider()
    const legitimate = defineMcpServer({
      name: "project",
      transport: { command: "node", type: "stdio" },
    })

    for (const lookalike of [
      {
        name: "structural",
        transport: { command: "node", type: "stdio" },
      },
      { ...legitimate },
      new Proxy(legitimate, {}),
    ]) {
      await expect(
        new AmlRuntime({ agentProvider: provider }).evaluate(
          <Agent>
            <Mcp use={lookalike as never} />
            prompt
          </Agent>,
        ),
      ).rejects.toThrow("<Mcp use> must be a defined MCP server")
    }

    expect(provider.calls).toHaveLength(0)
  })

  it("collects grants returned asynchronously by ordinary components", async () => {
    const resolveComponent = vi.fn(async () => <Mcp name="project" />)
    const provider = new DeterministicAgentProvider({
      respond(request) {
        expect(request.mcpServers).toEqual([
          { kind: "named", name: "project" },
        ])
        return { text: "done" }
      },
    })

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          {resolveComponent()}
          prompt
        </Agent>,
      ),
    ).resolves.toBe("done")
    expect(resolveComponent).toHaveBeenCalledOnce()
  })
})
