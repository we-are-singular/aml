import { Agent, AmlRuntime, Sandbox, type SandboxProcess } from "@aml-jsx/sdk"
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
      exec: command => ({
        exitCode: 0,
        stderr: "",
        stdout: command === "pwd" ? "/sandbox/repository\n" : "",
      }),
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
          prompt: "Follow the system.",
          tools: { "*": true },
        },
      },
      default_agent: "aml",
      model: "anthropic/claude-sonnet-4-6",
      share: "disabled",
    })
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

    expect(config).toMatchObject({
      agent: {
        aml: {
          permission: { "*": "allow", bash: "deny", edit: "deny", webfetch: "deny", websearch: "deny", write: "deny" },
          tools: { "*": true, bash: false, edit: false, webfetch: false, websearch: false, write: false },
        },
      },
    })
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

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
}
