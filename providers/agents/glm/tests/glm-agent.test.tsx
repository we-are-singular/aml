import { Agent, AmlRuntime, Sandbox, type AmlTraceEvent, type SandboxProcess } from "@aml-jsx/sdk"
import { DeterministicSandboxProvider } from "@aml-jsx/sdk/testing"
import { describe, expect, it } from "vitest"

import { glmAgent } from "../src/index.js"

describe("glmAgent()", () => {
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
    const provider = glmAgent({
      apiKey: "configured",
      args: ["--verbose"],
      baseUrl: "https://custom.example/api/coding/paas/v4",
      command: "custom-glm-acp",
      env: { EXTRA: "value" },
      maxTokens: 4096,
      model: "provider-model",
    })

    await expect(
      new AmlRuntime({ agentProvider: provider, trace: event => traceEvents.push(event) }).evaluate(
        <Sandbox access="read-write" cwd="repository" provider={sandboxProvider}>
          <Agent model="glm-test" system="Follow the system.">
            Initial
          </Agent>
        </Sandbox>
      )
    ).rejects.toThrow()
    expect(spawned).toMatchObject([
      expect.objectContaining({
        args: ["--verbose"],
        command: "custom-glm-acp",
        options: expect.objectContaining({
          cwd: "repository",
          env: expect.objectContaining({
            ACP_GLM_BASE_URL: "https://custom.example/api/coding/paas/v4",
            ACP_GLM_MAX_TOKENS: "4096",
            ACP_GLM_MODEL: "glm-test",
            ACP_GLM_SESSION_DIR: expect.stringMatching(/^\/tmp\/aml-acp-[^/]+\/sessions$/),
            EXTRA: "value",
            Z_AI_API_KEY: "configured",
          }),
        }),
      }),
    ])
    expect(
      traceEvents.find(
        event => event.type === "event" && event.name === "sandbox.process" && event.attributes.state === "started"
      )
    ).toMatchObject({
      attributes: { "execution.id": "glm-acp-agent-process", state: "started" },
    })
    expect(
      traceEvents
        .filter(event => event.type === "event" && event.name === "sandbox.process")
        .map(event => event.attributes.state)
    ).toEqual(["spawn_requested", "started", "kill_requested", "kill_completed", "exited"])
    expect(JSON.stringify(traceEvents)).not.toContain("custom-glm-acp")
    expect(JSON.stringify(traceEvents)).not.toContain("configured")
  })

  it("uses the provider model when the Agent does not override it", async () => {
    let environment: Record<string, string> | undefined
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: command => ({ exitCode: 0, stderr: "", stdout: command === "pwd" ? "/sandbox/repository\n" : "" }),
      spawn(_command, _args, _request, options) {
        environment = options.env
        return completedProcess()
      },
    })

    await expect(
      new AmlRuntime({ agentProvider: glmAgent({ model: "provider-model" }) }).evaluate(
        <Sandbox provider={sandboxProvider}>
          <Agent>Prompt</Agent>
        </Sandbox>
      )
    ).rejects.toThrow()

    expect(environment).toMatchObject({ ACP_GLM_MODEL: "provider-model" })
  })

  it("keeps adapter session state inside the invocation-private state directory", async () => {
    let environment: Record<string, string> | undefined
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: command => ({ exitCode: 0, stderr: "", stdout: command === "pwd" ? "/sandbox/repository\n" : "" }),
      spawn(_command, _args, _request, options) {
        environment = options.env
        return completedProcess()
      },
    })

    await expect(
      new AmlRuntime({ agentProvider: glmAgent() }).evaluate(
        <Sandbox provider={sandboxProvider}>
          <Agent>Prompt</Agent>
        </Sandbox>
      )
    ).rejects.toThrow()

    expect(environment?.ACP_GLM_SESSION_DIR).toMatch(/^\/tmp\/aml-acp-[^/]+\/sessions$/)
    expect(environment?.Z_AI_API_KEY).toBeUndefined()
  })

  it("validates process configuration without external work", () => {
    expect(() => glmAgent({ command: " glm-acp-agent " })).toThrow("command must be a non-empty normalized string")
    expect(() => glmAgent({ maxTokens: 0 })).toThrow("GLM maxTokens must be a positive safe integer")
    expect(() => glmAgent({ maxTokens: 1.5 })).toThrow("GLM maxTokens must be a positive safe integer")
    expect(() => glmAgent({ model: " glm-5.3 " })).toThrow("model must be a non-empty normalized string")
  })
})

function completedProcess(): Readonly<SandboxProcess> {
  return Object.freeze({
    id: "glm-acp-agent-process",
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
