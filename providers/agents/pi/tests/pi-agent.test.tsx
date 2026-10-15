import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { agent, methods, ndJsonStream, type SessionConfigOption } from "@agentclientprotocol/sdk"
import { Agent, AmlRuntime, defineMcpServer, Mcp, Sandbox, type SandboxProcess } from "@aml-jsx/sdk"
import { DeterministicSandboxProvider } from "@aml-jsx/sdk/testing"
import { describe, expect, it, vi } from "vitest"

import { piAgent } from "../src/index.js"

describe("piAgent()", () => {
  it("launches pi-acp and configures the underlying Agent through ACP", async () => {
    const prompts: string[] = []
    const configuredThinkingLevels: string[] = []
    const executed: Array<{
      readonly args: readonly string[]
      readonly command: string
      readonly options: Readonly<{ cwd?: string; env?: Readonly<Record<string, string>> }>
    }> = []
    const spawned: Array<{
      readonly args: readonly string[]
      readonly command: string
      readonly options: Readonly<{ cwd?: string; env?: Readonly<Record<string, string>> }>
    }> = []
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: (command, args, _request, options) => {
        executed.push({ args, command, options })
        return {
          exitCode: 0,
          stderr: "",
          stdout: command === "pwd" ? "/sandbox/repository\n" : "",
        }
      },
      spawn(command, args, _request, options) {
        spawned.push({ args, command, options })
        return acpFixtureProcess(prompt => prompts.push(prompt), {
          onThinkingLevel(value) {
            configuredThinkingLevels.push(value)
          },
          thinkingLevel: "ultra",
        })
      },
    })
    const provider = piAgent({
      args: ["--fixture"],
      command: "custom-pi-acp",
      env: { OPENCODE_API_KEY: "configured" },
      model: "opencode-go/minimax-m3",
      piCommand: "custom-pi",
      thinkingLevel: "ultra",
    })

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Sandbox access="read-write" cwd="repository" provider={sandboxProvider}>
          <Agent model="opencode-go/glm-5.1" system="Follow the system.">
            Initial
          </Agent>
        </Sandbox>
      )
    ).resolves.toBe("")
    expect(executed).toContainEqual({
      args: [
        "-c",
        'umask 077 && printf %s "$AML_MATERIALIZED_FILE" > "$1"',
        "aml-materialize",
        expect.stringMatching(/^\/tmp\/aml-acp-.*\/agent\/settings\.json$/),
      ],
      command: "sh",
      options: {
        env: { AML_MATERIALIZED_FILE: '{\n  "quietStartup": true\n}\n' },
        signal: expect.any(AbortSignal),
      },
    })
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({
      args: ["--fixture"],
      command: "custom-pi-acp",
      options: {
        cwd: "repository",
        env: expect.objectContaining({
          HOME: expect.stringMatching(/^\/tmp\/aml-acp-/),
          OPENCODE_API_KEY: "configured",
          PI_ACP_PI_COMMAND: "custom-pi",
          PI_CODING_AGENT_DIR: expect.stringMatching(/^\/tmp\/aml-acp-/),
          PI_CODING_AGENT_SESSION_DIR: expect.stringMatching(/^\/tmp\/aml-acp-/),
          PI_SKIP_VERSION_CHECK: "1",
        }),
      },
    })
    expect(prompts).toEqual(["<SYSTEM>\nFollow the system.\n</SYSTEM>\n\nInitial"])
    expect(configuredThinkingLevels).toEqual(["ultra"])
  })

  it("writes MCP servers where the pinned pi-mcp-adapter keeps AML's server settings", async () => {
    const files = new Map<string, string>()
    const sandboxProvider = new DeterministicSandboxProvider({
      exec(command, args, _request, options) {
        const destination = args[3]
        if (command === "sh" && destination !== undefined && options.env?.AML_MATERIALIZED_FILE !== undefined) {
          files.set(path.posix.basename(destination), options.env.AML_MATERIALIZED_FILE)
        }
        return { exitCode: 0, stderr: "", stdout: command === "pwd" ? "/sandbox/repository\n" : "" }
      },
      spawn() {
        return acpFixtureProcess(() => {}, {})
      },
    })
    const docs = defineMcpServer({
      name: "docs",
      transport: {
        headers: { authorization: "Bearer docs" },
        type: "streamable-http",
        url: "https://example.test/mcp",
      },
    })

    await new AmlRuntime({ agentProvider: piAgent() }).evaluate(
      <Sandbox access="read-write" provider={sandboxProvider}>
        <Agent>
          <Mcp use={docs} />
          Use docs.
        </Agent>
      </Sandbox>
    )

    expect(files.has("mcp.json")).toBe(false)
    const adapterConfig = files.get("mcp-adapter.json")
    if (adapterConfig === undefined) throw new Error("Pi profile did not write mcp-adapter.json")

    // Load the generated file through the installed adapter, as Pi 0.99+ does.
    const directory = await mkdtemp(path.join(os.tmpdir(), "aml-pi-adapter-config-"))
    try {
      await writeFile(path.join(directory, "mcp-adapter.json"), adapterConfig)
      vi.stubEnv("HOME", directory)
      vi.stubEnv("PI_CODING_AGENT_DIR", directory)
      const adapter = (await import(new URL("dist/config.js", import.meta.resolve("pi-mcp-adapter")).href)) as {
        loadMcpConfig(overridePath: string | undefined, cwd: string): { mcpServers: Record<string, unknown> }
        setPiMcpConfigEnabled(enabled: boolean): void
      }
      adapter.setPiMcpConfigEnabled(true)

      expect(adapter.loadMcpConfig(undefined, directory).mcpServers.docs).toEqual({
        directTools: false,
        headers: { authorization: "Bearer docs" },
        lifecycle: "lazy",
        toolPrefix: "none",
        url: "https://example.test/mcp",
      })
    } finally {
      vi.unstubAllEnvs()
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("validates adapter configuration without external work", () => {
    expect(() => piAgent({ command: " pi-acp " })).toThrow("Pi ACP command must be a non-empty normalized string")
  })
})

function acpFixtureProcess(
  onPrompt: (prompt: string) => void,
  options: { readonly onThinkingLevel?: (value: string) => void; readonly thinkingLevel?: string } = {}
): Readonly<SandboxProcess> {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const configOptions: SessionConfigOption[] = [
    {
      category: "model",
      currentValue: "opencode-go/glm-5.1",
      id: "model",
      name: "Model",
      options: [{ name: "GLM 5.1", value: "opencode-go/glm-5.1" }],
      type: "select",
    },
    {
      category: "thought_level",
      currentValue: options.thinkingLevel ?? "high",
      id: "thinking-level",
      name: "Thinking level",
      options: [{ name: options.thinkingLevel ?? "high", value: options.thinkingLevel ?? "high" }],
      type: "select",
    },
  ]
  const app = agent({ name: "pi-test" })
    .onRequest(methods.agent.initialize, ({ params }) => ({
      agentCapabilities: {},
      protocolVersion: params.protocolVersion,
    }))
    .onRequest(methods.agent.session.new, () => ({ configOptions, sessionId: "pi-test-session" }))
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      if (params.configId === "thinking-level" && typeof params.value === "string") {
        options.onThinkingLevel?.(params.value)
      }
      return { configOptions }
    })
    .onRequest(methods.agent.session.prompt, ({ params }) => {
      onPrompt(params.prompt.flatMap(block => (block.type === "text" ? [block.text] : [])).join(""))
      return { stopReason: "end_turn" }
    })
  const connection = app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable))

  return Object.freeze({
    id: "pi-acp-fixture",
    async kill() {
      connection.close()
    },
    stdin: clientToAgent.writable,
    stderr: emptyStream(),
    stdout: agentToClient.readable,
    async wait() {
      await connection.closed
      return { exitCode: 0 }
    },
  })
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
}
