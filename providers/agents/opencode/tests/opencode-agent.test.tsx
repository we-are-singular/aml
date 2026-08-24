import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk"
import { Agent, AmlRuntime, FollowUp, Sandbox, type SandboxProcess } from "@aml-jsx/sdk"
import { DeterministicSandboxProvider } from "@aml-jsx/sdk/testing"
import { describe, expect, it } from "vitest"

import { opencodeAgent } from "../src/index.js"

describe("opencodeAgent()", () => {
  it("launches the native ACP Agent through the Sandbox process boundary", async () => {
    const spawned: Array<{
      readonly args: readonly string[]
      readonly command: string
      readonly options: Readonly<{ cwd?: string; env?: Readonly<Record<string, string>> }>
    }> = []
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: command => ({ exitCode: 0, stderr: "", stdout: command === "pwd" ? "/sandbox/repository\n" : "" }),
      spawn(command, args, _request, options) {
        spawned.push({ args, command, options })
        return completedProcess()
      },
    })
    const provider = opencodeAgent({
      args: ["--print-logs"],
      command: "custom-opencode",
      config: { share: "disabled" },
      env: { PROVIDER_TOKEN: "configured" },
      model: "opencode-go/minimax-m3",
    })

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Sandbox access="read-write" cwd="repository" provider={sandboxProvider}>
          <Agent model="anthropic/claude-sonnet-4-6" system="Follow the system.">
            Initial
          </Agent>
        </Sandbox>
      )
    ).rejects.toThrow()
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({
      args: ["acp", "--pure", "--cwd", "/sandbox/repository", "--print-logs"],
      command: "custom-opencode",
      options: {
        cwd: "repository",
        env: expect.objectContaining({
          OPENCODE_DB: expect.stringMatching(/^\/tmp\/aml-acp-[^/]+\/opencode\.db$/),
          PROVIDER_TOKEN: "configured",
          XDG_DATA_HOME: expect.stringMatching(/^\/tmp\/aml-acp-/),
        }),
      },
    })

    const config = JSON.parse(spawned[0]?.options.env?.OPENCODE_CONFIG_CONTENT ?? "")
    expect(config).toMatchObject({
      agent: {
        aml: {
          mode: "primary",
          permission: { "*": "allow" },
          tools: { "*": true },
        },
      },
      default_agent: "aml",
      model: "anthropic/claude-sonnet-4-6",
      share: "disabled",
    })
    expect(config.agent.aml).not.toHaveProperty("prompt")
  })

  it("prepends non-empty System content to the first ACP turn in literal tags", async () => {
    const prompts: string[] = []
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: command => ({ exitCode: 0, stderr: "", stdout: command === "pwd" ? "/sandbox/repository\n" : "" }),
      spawn() {
        return acpFixtureProcess(prompt => prompts.push(prompt))
      },
    })

    await expect(
      new AmlRuntime({ agentProvider: opencodeAgent() }).evaluate(
        <Sandbox provider={sandboxProvider}>
          <Agent system="Follow the system.">
            Initial
            <FollowUp>Second</FollowUp>
          </Agent>
        </Sandbox>
      )
    ).resolves.toBe("")

    expect(prompts).toEqual(["<SYSTEM>\nFollow the system.\n</SYSTEM>\n\nInitial", "Second"])
  })

  it("does not add a first-turn prelude when System content is empty", async () => {
    const prompts: string[] = []
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: command => ({ exitCode: 0, stderr: "", stdout: command === "pwd" ? "/sandbox/repository\n" : "" }),
      spawn() {
        return acpFixtureProcess(prompt => prompts.push(prompt))
      },
    })

    await new AmlRuntime({ agentProvider: opencodeAgent() }).evaluate(
      <Sandbox provider={sandboxProvider}>
        <Agent>Initial</Agent>
      </Sandbox>
    )

    expect(prompts).toEqual(["Initial"])
  })

  it("maps restrictive Agent permissions into OpenCode's native controls", async () => {
    let config: Record<string, unknown> | undefined
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: command => ({ exitCode: 0, stderr: "", stdout: command === "pwd" ? "/sandbox/repository\n" : "" }),
      spawn(_command, _args, _request, options) {
        config = JSON.parse(options.env?.OPENCODE_CONFIG_CONTENT ?? "")
        return completedProcess()
      },
    })
    const provider = opencodeAgent()

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Sandbox provider={sandboxProvider}>
          <Agent permissions={{ filesystem: "read-only", network: false, shell: false }}>Prompt</Agent>
        </Sandbox>
      )
    ).rejects.toThrow()

    if (config === undefined) throw new Error("OpenCode configuration was not captured")
    expect(config).toMatchObject({
      agent: {
        aml: {
          permission: {
            "*": "allow",
            bash: "deny",
            edit: "deny",
            webfetch: "deny",
            websearch: "deny",
            write: "deny",
          },
          tools: {
            "*": true,
            bash: false,
            edit: false,
            webfetch: false,
            websearch: false,
            write: false,
          },
        },
      },
      permission: {
        bash: "deny",
        edit: "deny",
        webfetch: "deny",
        websearch: "deny",
      },
    })
    expect(config).not.toHaveProperty("agent.aml.permission.task")
    expect(config).not.toHaveProperty("agent.aml.tools.task")
    expect(config).not.toHaveProperty("instructions")
    expect((config.agent as { aml: unknown }).aml).not.toHaveProperty("prompt")
  })

  it("validates process configuration without external work", () => {
    expect(() => opencodeAgent({ command: " opencode " })).toThrow(
      "OpenCode command must be a non-empty normalized string"
    )
  })
})

function completedProcess(): Readonly<SandboxProcess> {
  return Object.freeze({
    id: "opencode-acp-process",
    async kill() {},
    stdin: new WritableStream(),
    stderr: emptyStream(),
    stdout: emptyStream(),
    async wait() {
      return { exitCode: 0 }
    },
  })
}

function acpFixtureProcess(onPrompt: (prompt: string) => void): Readonly<SandboxProcess> {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const app = agent({ name: "opencode-test" })
    .onRequest(methods.agent.initialize, ({ params }) => ({
      agentCapabilities: {},
      protocolVersion: params.protocolVersion,
    }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: "opencode-test-session" }))
    .onRequest(methods.agent.session.prompt, ({ params }) => {
      onPrompt(params.prompt.flatMap(block => (block.type === "text" ? [block.text] : [])).join(""))
      return { stopReason: "end_turn" }
    })
  const connection = app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable))

  return Object.freeze({
    id: "opencode-acp-fixture",
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
