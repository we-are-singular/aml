import {
  Agent,
  AmlRuntime,
  defineMcpServer,
  FollowUp,
  Mcp,
  Sandbox,
  type AcpSessionFactory,
  type AcpSessionOpenInput,
  type AgentProviderSession,
  type SandboxProcess,
} from "@aml-jsx/sdk"
import { DeterministicSandboxProvider } from "@aml-jsx/sdk/testing"
import { describe, expect, it } from "vitest"

import { codexAgent } from "../src/index.js"

class RecordingSessionFactory implements AcpSessionFactory {
  readonly inputs: AcpSessionOpenInput[] = []
  readonly prompts: string[] = []

  async open(input: Readonly<AcpSessionOpenInput>): Promise<AgentProviderSession> {
    this.inputs.push(input)
    return {
      close: async () => await input.process.kill(),
      runTurn: async turn => {
        this.prompts.push(turn.prompt)
        return { text: `response:${turn.prompt}` }
      },
    }
  }
}

describe("codexAgent()", () => {
  it("lets the Agent own ACP while the Sandbox only spawns its process", async () => {
    const sessionFactory = new RecordingSessionFactory()
    const spawned: Array<{
      args: readonly string[]
      command: string
      options: Readonly<{ cwd?: string; env?: Readonly<Record<string, string>> }>
    }> = []
    const process = completedProcess()
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: command => ({
        exitCode: 0,
        stderr: "",
        stdout: command === "pwd" ? "/sandbox/repository\n" : "",
      }),
      spawn(command, args, _request, options) {
        spawned.push({ args, command, options })
        return process
      },
    })
    const provider = codexAgent({
      apiKey: "configured",
      args: ["--stdio"],
      command: "custom-codex-acp",
      config: { custom: true },
      env: { EXTRA: "value" },
      sessionFactory,
    })

    const output = await new AmlRuntime({ agentProvider: provider }).evaluate(
      <Sandbox access="read-write" cwd="repository" provider={sandboxProvider}>
        <Agent model="gpt-test" system="Follow the system.">
          Initial
          <FollowUp>Later</FollowUp>
        </Agent>
      </Sandbox>
    )

    expect(output).toBe("response:Later")
    expect(sessionFactory.inputs).toEqual([
      expect.objectContaining({
        authenticationMethodId: "api-key",
        cwd: "/sandbox/repository",
        permissionPolicy: "allow_always",
        process: expect.objectContaining({ id: process.id }),
      }),
    ])
    expect(sessionFactory.prompts).toEqual(["Initial", "Later"])
    expect(spawned).toMatchObject([
      expect.objectContaining({
        args: ["--stdio"],
        command: "custom-codex-acp",
        options: expect.objectContaining({
          cwd: "repository",
          env: expect.objectContaining({
            APP_SERVER_LOGS: expect.stringMatching(/^\/tmp\/aml-acp-[^/]+\/logs$/),
            CODEX_API_KEY: "configured",
            CODEX_HOME: expect.stringMatching(/^\/tmp\/aml-acp-/),
            CODEX_SQLITE_HOME: expect.stringMatching(/^\/tmp\/aml-acp-/),
            EXTRA: "value",
            INITIAL_AGENT_MODE: "agent-full-access",
            NO_BROWSER: "1",
          }),
        }),
      }),
    ])
    expect(JSON.parse(spawned[0]?.options.env?.CODEX_CONFIG ?? "")).toEqual({
      custom: true,
      developer_instructions: "Follow the system.",
      model: "gpt-test",
    })
  })

  it("uses the same ACP session over the trusted local process launcher", async () => {
    const sessionFactory = new RecordingSessionFactory()
    const provider = codexAgent({
      args: ["-e", "setInterval(() => {}, 1_000)"],
      command: process.execPath,
      sessionFactory,
      workingDirectory: process.cwd(),
    })

    await expect(new AmlRuntime({ agentProvider: provider }).evaluate(<Agent>Prompt</Agent>)).resolves.toBe(
      "response:Prompt"
    )
    expect(sessionFactory.inputs).toEqual([
      expect.objectContaining({
        cwd: process.cwd(),
        process: expect.objectContaining({
          id: expect.stringMatching(/^local-process:/),
        }),
      }),
    ])
  })

  it("maps portable MCP servers into the shared ACP session", async () => {
    const sessionFactory = new RecordingSessionFactory()
    const server = defineMcpServer({
      name: "catalog",
      transport: {
        args: ["--stdio"],
        command: "/opt/catalog-mcp",
        env: { TOKEN: "configured" },
        type: "stdio",
      },
    })
    const provider = codexAgent({
      args: ["-e", "setInterval(() => {}, 1_000)"],
      command: process.execPath,
      sessionFactory,
      workingDirectory: process.cwd(),
    })

    await new AmlRuntime({ agentProvider: provider }).evaluate(
      <Agent>
        <Mcp use={server} />
        Prompt
      </Agent>
    )

    expect(sessionFactory.inputs[0]?.mcpServers).toEqual([
      {
        args: ["--stdio"],
        command: "/opt/catalog-mcp",
        env: [{ name: "TOKEN", value: "configured" }],
        name: "catalog",
      },
    ])
  })

  it("validates process configuration without external work", () => {
    expect(() => codexAgent({ command: " codex-acp " })).toThrow("command must be a non-empty normalized string")
  })
})

function completedProcess(): Readonly<SandboxProcess> {
  return Object.freeze({
    async closeInput() {},
    id: "codex-acp-process",
    async kill() {},
    stderr: emptyStream(),
    stdout: emptyStream(),
    async wait() {
      return Object.freeze({ exitCode: 0 })
    },
    async write() {},
  })
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: controller => controller.close() })
}
