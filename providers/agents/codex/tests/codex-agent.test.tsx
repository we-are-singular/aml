import { Agent, AmlRuntime, Sandbox, type AmlTraceEvent, type SandboxProcess } from "@aml-jsx/sdk"
import { DeterministicSandboxProvider } from "@aml-jsx/sdk/testing"
import { describe, expect, it } from "vitest"

import { codexAgent } from "../src/index.js"

describe("codexAgent()", () => {
  it("lets the Agent own ACP while the Sandbox only spawns its process", async () => {
    const spawned: Array<{
      args: readonly string[]
      command: string
      options: Readonly<{ cwd?: string; env?: Readonly<Record<string, string>> }>
    }> = []
    const traceEvents: AmlTraceEvent[] = []
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
      codexPathOverride: "/opt/codex",
      config: { custom: true },
      env: { EXTRA: "value" },
      model: "provider-model",
      reasoningEffort: "high",
    })

    await expect(
      new AmlRuntime({ agentProvider: provider, trace: event => traceEvents.push(event) }).evaluate(
        <Sandbox access="read-write" cwd="repository" provider={sandboxProvider}>
          <Agent model="gpt-test" system="Follow the system.">
            Initial
          </Agent>
        </Sandbox>
      )
    ).rejects.toThrow()
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
            CODEX_PATH: "/opt/codex",
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
      model_reasoning_effort: "high",
    })
    expect(
      traceEvents.find(
        event => event.type === "event" && event.name === "sandbox.process" && event.attributes.state === "started"
      )
    ).toMatchObject({
      attributes: { "execution.id": "codex-acp-process", state: "started" },
    })
    expect(
      traceEvents
        .filter(event => event.type === "event" && event.name === "sandbox.process")
        .map(event => event.attributes.state)
    ).toEqual(["spawn_requested", "started", "kill_requested", "kill_completed", "exited"])
    expect(JSON.stringify(traceEvents)).not.toContain("custom-codex-acp")
  })

  it("uses the provider model when the Agent does not override it", async () => {
    let config: Record<string, unknown> | undefined
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: command => ({ exitCode: 0, stderr: "", stdout: command === "pwd" ? "/sandbox/repository\n" : "" }),
      spawn(_command, _args, _request, options) {
        config = JSON.parse(options.env?.CODEX_CONFIG ?? "")
        return completedProcess()
      },
    })

    await expect(
      new AmlRuntime({ agentProvider: codexAgent({ model: "provider-model" }) }).evaluate(
        <Sandbox provider={sandboxProvider}>
          <Agent>Prompt</Agent>
        </Sandbox>
      )
    ).rejects.toThrow()

    expect(config).toMatchObject({ model: "provider-model" })
  })

  it("validates process configuration without external work", () => {
    expect(() => codexAgent({ command: " codex-acp " })).toThrow("command must be a non-empty normalized string")
  })
})

function completedProcess(): Readonly<SandboxProcess> {
  return Object.freeze({
    id: "codex-acp-process",
    async kill() {},
    stdin: new WritableStream(),
    stderr: emptyStream(),
    stdout: emptyStream(),
    async wait() {
      return Object.freeze({ exitCode: 0 })
    },
  })
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: controller => controller.close() })
}
