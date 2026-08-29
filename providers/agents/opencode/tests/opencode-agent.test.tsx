import { agent, methods, ndJsonStream, type SessionConfigOption } from "@agentclientprotocol/sdk"
import { Agent, AmlRuntime, defineTool, evaluate, FollowUp, Sandbox, Tool, type SandboxProcess } from "@aml-jsx/sdk"
import { DeterministicSandboxProvider } from "@aml-jsx/sdk/testing"
import { describe, expect, it } from "vitest"
import { z } from "zod"

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
      env: { PROVIDER_TOKEN: "configured", XDG_DATA_HOME: "/staged/opencode-data" },
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
          XDG_DATA_HOME: "/staged/opencode-data",
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

  it("selects the configured model through the ACP session", async () => {
    const configuredModels: string[] = []
    const fallbackModel = "opencode/big-pickle"
    const model = "opencode/deepseek-v4-flash"
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: command => ({ exitCode: 0, stderr: "", stdout: command === "pwd" ? "/sandbox/repository\n" : "" }),
      spawn() {
        return acpFixtureProcess(() => {}, {
          advertisedModels: [fallbackModel, model],
          currentModel: fallbackModel,
          onModel: configuredModel => configuredModels.push(configuredModel),
        })
      },
    })

    await new AmlRuntime({ agentProvider: opencodeAgent({ model }) }).evaluate(
      <Sandbox provider={sandboxProvider}>
        <Agent>Initial</Agent>
      </Sandbox>
    )

    expect(configuredModels).toEqual([model])
  })

  it("rejects a configured model that the ACP Agent does not advertise", async () => {
    const prompts: string[] = []
    const model = "opencode/deepseek-v4-flash"
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: command => ({ exitCode: 0, stderr: "", stdout: command === "pwd" ? "/sandbox/repository\n" : "" }),
      spawn() {
        return acpFixtureProcess(prompt => prompts.push(prompt), {
          advertisedModels: ["opencode/big-pickle"],
          currentModel: "opencode/big-pickle",
        })
      },
    })

    await expect(
      new AmlRuntime({ agentProvider: opencodeAgent({ model }) }).evaluate(
        <Sandbox provider={sandboxProvider}>
          <Agent>Initial</Agent>
        </Sandbox>
      )
    ).rejects.toMatchObject({
      cause: { message: `ACP session configuration "model" does not advertise value "${model}"` },
    })
    expect(prompts).toEqual([])
  })

  it("rejects an ACP Agent that does not apply the configured model", async () => {
    const prompts: string[] = []
    const fallbackModel = "opencode/big-pickle"
    const model = "opencode/deepseek-v4-flash"
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: command => ({ exitCode: 0, stderr: "", stdout: command === "pwd" ? "/sandbox/repository\n" : "" }),
      spawn() {
        return acpFixtureProcess(prompt => prompts.push(prompt), {
          advertisedModels: [fallbackModel, model],
          applyModel: false,
          currentModel: fallbackModel,
        })
      },
    })

    await expect(
      new AmlRuntime({ agentProvider: opencodeAgent({ model }) }).evaluate(
        <Sandbox provider={sandboxProvider}>
          <Agent>Initial</Agent>
        </Sandbox>
      )
    ).rejects.toMatchObject({
      cause: { message: `ACP session configuration "model" did not apply value "${model}"` },
    })
    expect(prompts).toEqual([])
  })

  it("names generated OpenCode MCP tools in structured turns", async () => {
    const prompts: string[] = []
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: command => ({ exitCode: 0, stderr: "", stdout: command === "pwd" ? "/sandbox/repository\n" : "" }),
      spawn(command) {
        if (command === "node") return relayFixtureProcess()
        return acpFixtureProcess(prompt => prompts.push(prompt))
      },
    })
    const Result = z.object({ proof: z.string() })
    const readEvidence = defineTool({
      description: "Read evidence",
      execute: async () => "evidence",
      input: z.object({}),
      name: "read_evidence",
    })

    async function StructuredResult() {
      return JSON.stringify(
        await evaluate(
          <Agent system="Follow the system.">
            <Tool use={readEvidence} />
            Submit proof.
          </Agent>,
          Result
        )
      )
    }

    await expect(
      new AmlRuntime({ agentProvider: opencodeAgent() }).evaluate(
        <Sandbox provider={sandboxProvider}>
          <StructuredResult />
        </Sandbox>
      )
    ).rejects.toThrow('Agent "opencode"')

    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toMatch(
      /^<SYSTEM>\nFollow the system\.\n<\/SYSTEM>\n\nAML JavaScript Tools use these OpenCode MCP tool names:\n- read_evidence: aml_[a-f0-9]+_read_evidence\n\nSubmit proof\.\n\nCall the OpenCode MCP tool "aml_[a-f0-9]+_aml_submit_result"/u
    )
    expect(prompts[1]).toMatch(
      /^The previous turn ended without submitting a valid structured result\.\n\nCall the OpenCode MCP tool "aml_[a-f0-9]+_aml_submit_result"/u
    )
    expect(prompts[1]).toContain('"proof"')
  })

  it("merges caller-disabled native tools before portable permission denials", async () => {
    let config: Record<string, unknown> | undefined
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: command => ({ exitCode: 0, stderr: "", stdout: command === "pwd" ? "/sandbox/repository\n" : "" }),
      spawn(_command, _args, _request, options) {
        config = JSON.parse(options.env?.OPENCODE_CONFIG_CONTENT ?? "")
        return completedProcess()
      },
    })
    const provider = opencodeAgent({
      config: {
        agent: { aml: { tools: { edit: true, question: false, write: true } } },
        permission: { bash: "allow", question: "deny" },
        tools: { question: true, task: false },
      },
    })

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
            question: false,
            task: false,
            webfetch: false,
            websearch: false,
            write: false,
          },
        },
      },
      permission: {
        bash: "deny",
        edit: "deny",
        question: "deny",
        webfetch: "deny",
        websearch: "deny",
      },
    })
    expect(config).not.toHaveProperty("agent.aml.permission.task")
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

function acpFixtureProcess(
  onPrompt: (prompt: string) => void,
  options: {
    readonly advertisedModels?: readonly string[]
    readonly applyModel?: boolean
    readonly currentModel?: string
    readonly onModel?: (value: string) => void
  } = {}
): Readonly<SandboxProcess> {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  let currentModel = options.currentModel
  const configOptions = (): SessionConfigOption[] =>
    options.advertisedModels === undefined
      ? []
      : [
          {
            currentValue: currentModel ?? options.advertisedModels[0] ?? "opencode/big-pickle",
            id: "model",
            name: "Model",
            options: options.advertisedModels.map(model => ({ name: model, value: model })),
            type: "select",
          },
        ]
  const app = agent({ name: "opencode-test" })
    .onRequest(methods.agent.initialize, ({ params }) => ({
      agentCapabilities: { mcpCapabilities: { http: true } },
      protocolVersion: params.protocolVersion,
    }))
    .onRequest(methods.agent.session.new, () => ({
      configOptions: configOptions(),
      sessionId: "opencode-test-session",
    }))
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      if (params.configId === "model" && typeof params.value === "string") {
        if (options.applyModel !== false) currentModel = params.value
        options.onModel?.(params.value)
      }
      return { configOptions: configOptions() }
    })
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

function relayFixtureProcess(): Readonly<SandboxProcess> {
  let resolveExited: () => void = () => {}
  const exited = new Promise<void>(resolve => {
    resolveExited = resolve
  })
  let closed = false
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller
      controller.enqueue(new TextEncoder().encode('{"kind":"ready","port":4567}\n'))
    },
  })

  return Object.freeze({
    id: "opencode-mcp-relay-fixture",
    async kill() {
      if (closed) return
      closed = true
      stdoutController?.close()
      resolveExited()
    },
    stdin: new WritableStream(),
    stderr: emptyStream(),
    stdout,
    async wait() {
      await exited
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
