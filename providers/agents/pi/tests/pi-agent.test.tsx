import { agent, methods, ndJsonStream, type SessionConfigOption } from "@agentclientprotocol/sdk"
import { Agent, AmlRuntime, Sandbox, type SandboxProcess } from "@aml-jsx/sdk"
import { DeterministicSandboxProvider } from "@aml-jsx/sdk/testing"
import { describe, expect, it } from "vitest"

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
