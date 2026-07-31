import {
  Agent,
  AmlRuntime,
  defineTool,
  FollowUp,
  Sandbox,
  Tool,
  type AcpSessionFactory,
  type AcpSessionOpenInput,
  type AgentProviderSession,
  type SandboxProcess,
} from "@aml-jsx/sdk"
import { DeterministicSandboxProvider } from "@aml-jsx/sdk/testing"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { piAgent } from "../src/index.js"

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

describe("piAgent()", () => {
  it("launches pi-acp and configures the underlying Agent through ACP", async () => {
    const sessionFactory = new RecordingSessionFactory()
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
        return completedProcess()
      },
    })
    const provider = piAgent({
      args: ["--fixture"],
      command: "custom-pi-acp",
      env: { OPENCODE_API_KEY: "configured" },
      model: "opencode-go/minimax-m3",
      piCommand: "custom-pi",
      sessionFactory,
      thinkingLevel: "high",
    })

    const output = await new AmlRuntime({ agentProvider: provider }).evaluate(
      <Sandbox access="read-write" cwd="repository" provider={sandboxProvider}>
        <Agent model="opencode-go/glm-5.1" system="Follow the system.">
          Initial
          <FollowUp>Later</FollowUp>
        </Agent>
      </Sandbox>
    )

    expect(output).toBe("response:Later")
    expect(sessionFactory.inputs).toEqual([
      expect.objectContaining({
        configuration: [
          { category: "model", value: "opencode-go/glm-5.1" },
          { category: "thought_level", value: "high" },
        ],
        cwd: "/sandbox/repository",
        initialPromptPrefix: "System instructions for this AML session:\nFollow the system.",
        permissionPolicy: "allow_always",
      }),
    ])
    expect(sessionFactory.prompts).toEqual(["Initial", "Later"])
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
  })

  it("uses the same pi-acp profile on the trusted host", async () => {
    const sessionFactory = new RecordingSessionFactory()
    const provider = piAgent({
      args: ["-e", "setInterval(() => {}, 1_000)"],
      command: process.execPath,
      sessionFactory,
      workingDirectory: process.cwd(),
    })

    await expect(new AmlRuntime({ agentProvider: provider }).evaluate(<Agent>Prompt</Agent>)).resolves.toBe(
      "response:Prompt"
    )
    expect(sessionFactory.inputs[0]).toMatchObject({
      cwd: process.cwd(),
      process: { id: expect.stringMatching(/^local-process:/) },
    })
  })

  it("routes JavaScript Tools through the environment-provided Pi MCP extension", async () => {
    const tool = defineTool({
      description: "Fixture tool",
      input: z.object({}),
      name: "fixture_tool",
      async execute() {
        return "fixture"
      },
    })
    const defaultAdapter = piAgent({
      args: ["-e", "setInterval(() => {}, 1_000)"],
      command: process.execPath,
      sessionFactory: new RecordingSessionFactory(),
      workingDirectory: process.cwd(),
    })

    await expect(
      new AmlRuntime({ agentProvider: defaultAdapter }).evaluate(
        <Agent>
          <Tool use={tool} />
          Prompt
        </Agent>
      )
    ).resolves.toBe("response:Prompt")

    const sessionFactory = new RecordingSessionFactory()
    const withAdapter = piAgent({
      args: ["-e", "setInterval(() => {}, 1_000)"],
      command: process.execPath,
      mcpAdapterPath: "/opt/pi-mcp-adapter/index.ts",
      sessionFactory,
      workingDirectory: process.cwd(),
    })
    await expect(
      new AmlRuntime({ agentProvider: withAdapter }).evaluate(
        <Agent>
          <Tool use={tool} />
          Prompt
        </Agent>
      )
    ).resolves.toBe("response:Prompt")
    expect(sessionFactory.inputs[0]?.mcpServers).toEqual([])
  })

  it("validates adapter configuration without external work", () => {
    expect(() => piAgent({ command: " pi-acp " })).toThrow("Pi ACP command must be a non-empty normalized string")
    expect(() => piAgent({ thinkingLevel: "impossible" as "high" })).toThrow("Pi thinkingLevel is unsupported")
  })
})

function completedProcess(): Readonly<SandboxProcess> {
  return Object.freeze({
    async closeInput() {},
    id: "pi-acp-process",
    async kill() {},
    stderr: emptyStream(),
    stdout: emptyStream(),
    async wait() {
      return { exitCode: 0 }
    },
    async write() {},
  })
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
}
