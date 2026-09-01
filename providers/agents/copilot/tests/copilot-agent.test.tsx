import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk"
import { Agent, AmlRuntime, defineTool, evaluate, Sandbox, Tool, type SandboxProcess } from "@aml-jsx/sdk"
import { DeterministicSandboxProvider } from "@aml-jsx/sdk/testing"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { copilotAgent } from "../src/index.js"

afterEach(() => vi.unstubAllEnvs())

describe("copilotAgent()", () => {
  it("launches an isolated Copilot ACP session with explicit configuration", async () => {
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
    const provider = copilotAgent({
      args: ["--fixture"],
      command: "custom-copilot",
      env: { EXTRA: "value", GH_TOKEN: "explicit-gh-token" },
      model: "provider-model",
      reasoningEffort: "low",
    })

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Sandbox access="read-write" cwd="repository" provider={sandboxProvider}>
          <Agent model="gpt-5-mini" system="Follow the system.">
            Initial
          </Agent>
        </Sandbox>
      )
    ).rejects.toThrow()

    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({
      args: [
        "--fixture",
        "--acp",
        "--no-auto-update",
        expect.stringMatching(/^--log-dir=\/tmp\/aml-acp-[^/]+\/logs$/),
        "--no-custom-instructions",
        "--disable-builtin-mcps",
        "--no-ask-user",
        "--auth-token-env=GH_TOKEN",
        "--no-auto-login",
        "--no-color",
        "--no-remote",
        "--no-remote-export",
        "--model=gpt-5-mini",
        "--reasoning-effort=low",
      ],
      command: "custom-copilot",
      options: {
        cwd: "repository",
        env: {
          COPILOT_HOME: expect.stringMatching(/^\/tmp\/aml-acp-/),
          EXTRA: "value",
          GH_TOKEN: "explicit-gh-token",
          HOME: expect.stringMatching(/^\/tmp\/aml-acp-/),
        },
      },
    })
  })

  it("maps narrowed permissions to Copilot deny rules", async () => {
    let launchArgs: readonly string[] = []
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: command => ({ exitCode: 0, stderr: "", stdout: command === "pwd" ? "/sandbox/repository\n" : "" }),
      spawn(_command, args) {
        launchArgs = args
        return completedProcess()
      },
    })

    await expect(
      new AmlRuntime({ agentProvider: copilotAgent() }).evaluate(
        <Sandbox access="read-write" provider={sandboxProvider}>
          <Agent permissions={{ filesystem: "read-only", network: false, shell: false }}>Prompt</Agent>
        </Sandbox>
      )
    ).rejects.toThrow()

    expect(launchArgs).toContain("--deny-tool=write")
    expect(launchArgs).toContain("--deny-tool=shell")
    expect(launchArgs).toContain("--deny-tool=url")
    expect(launchArgs.some(argument => argument.startsWith("--auth-token-env="))).toBe(false)
    expect(launchArgs.slice(launchArgs.indexOf("--excluded-tools"))).toEqual([
      "--excluded-tools",
      "edit",
      "write",
      "bash",
      "web_fetch",
      "web_search",
    ])
  })

  it("prefers explicit token configuration over inherited local credentials", async () => {
    vi.stubEnv("COPILOT_GITHUB_TOKEN", "ambient-copilot-token")
    vi.stubEnv("GH_TOKEN", "ambient-gh-token")
    vi.stubEnv("GITHUB_TOKEN", "ambient-github-token")

    const launchArgs = await captureLocalLaunchArgs({ env: { GITHUB_TOKEN: "explicit-github-token" } })

    expect(launchArgs).toContain("--auth-token-env=GITHUB_TOKEN")
  })

  it("discovers native token variables from process.env for local launches", async () => {
    vi.stubEnv("COPILOT_GITHUB_TOKEN", "ambient-copilot-token")
    vi.stubEnv("GH_TOKEN", "ambient-gh-token")
    vi.stubEnv("GITHUB_TOKEN", "ambient-github-token")

    const launchArgs = await captureLocalLaunchArgs()

    expect(launchArgs).toContain("--auth-token-env=COPILOT_GITHUB_TOKEN")
  })

  it("uses Copilot-qualified names for AML JavaScript Tools and structured output", async () => {
    let mcpServerName: string | undefined
    const prompts: string[] = []
    const Result = z.object({ status: z.literal("done") })
    const proof = defineTool({
      description: "Return a deterministic proof",
      input: z.object({}),
      name: "copilot_proof",
      execute: async () => "proof",
    })
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: command => ({ exitCode: 0, stderr: "", stdout: command === "pwd" ? "/sandbox/repository\n" : "" }),
      spawn(command) {
        if (command === "node") return relayFixtureProcess()

        return acpFixtureProcess({
          onNewSession(servers) {
            mcpServerName = servers[0]?.name
          },
          onPrompt(value) {
            prompts.push(value)
          },
        })
      },
    })

    async function StructuredRequest() {
      await evaluate(
        <Agent system="Follow the authored system.">
          <Tool use={proof} />
          Call copilot_proof and submit the result.
        </Agent>,
        Result
      )
      return "unreachable"
    }

    await expect(
      new AmlRuntime({ agentProvider: copilotAgent() }).evaluate(
        <Sandbox access="read-write" provider={sandboxProvider}>
          <StructuredRequest />
        </Sandbox>
      )
    ).rejects.toThrow('Agent "copilot"')

    expect(mcpServerName).toBe("tools")
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain("<SYSTEM>\nFollow the authored system.\n</SYSTEM>")
    expect(prompts[0]).toContain(`- copilot_proof: ${mcpServerName}-copilot_proof`)
    expect(prompts[0]).toContain(`Call the Copilot MCP tool "${mcpServerName}-aml_submit_result" once`)
    expect(prompts[1]).toContain("The previous turn ended without submitting a valid structured result.")
    expect(prompts[1]).toContain(`Call the Copilot MCP tool "${mcpServerName}-aml_submit_result" once`)
    expect(prompts[1]).toContain('"status"')
  })

  it("validates options before launch and forwards arbitrary reasoning effort", async () => {
    expect(() => copilotAgent({ command: " copilot " })).toThrow(
      "Copilot command must be a non-empty normalized string"
    )

    const launchArgs = await captureLocalLaunchArgs({ reasoningEffort: "impossible" })

    expect(launchArgs).toContain("--reasoning-effort=impossible")
  })
})

async function captureLocalLaunchArgs(
  options: {
    readonly env?: Readonly<Record<string, string>>
    readonly reasoningEffort?: string
  } = {}
): Promise<readonly string[]> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aml-copilot-launch-test-"))
  const outputFile = path.join(directory, "args.json")
  const captureScript =
    'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))'

  try {
    await expect(
      new AmlRuntime({
        agentProvider: copilotAgent({
          args: ["--input-type=module", "-e", captureScript, outputFile],
          command: process.execPath,
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
        }),
      }).evaluate(<Agent>Prompt</Agent>)
    ).rejects.toThrow()

    return JSON.parse(await readFile(outputFile, "utf8")) as readonly string[]
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

function completedProcess(): Readonly<SandboxProcess> {
  return Object.freeze({
    id: "copilot-acp-process",
    async kill() {},
    stdin: new WritableStream(),
    stderr: emptyStream(),
    stdout: emptyStream(),
    async wait() {
      return { exitCode: 0 }
    },
  })
}

function acpFixtureProcess(hooks: {
  readonly onNewSession: (servers: readonly { readonly name: string }[]) => void
  readonly onPrompt: (prompt: string) => void
}): Readonly<SandboxProcess> {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const app = agent({ name: "copilot-test" })
    .onRequest(methods.agent.initialize, ({ params }) => ({
      agentCapabilities: { mcpCapabilities: { http: true } },
      protocolVersion: params.protocolVersion,
    }))
    .onRequest(methods.agent.session.new, ({ params }) => {
      hooks.onNewSession(params.mcpServers)
      return { sessionId: "copilot-test-session" }
    })
    .onRequest(methods.agent.session.prompt, ({ params }) => {
      hooks.onPrompt(params.prompt.flatMap(block => (block.type === "text" ? [block.text] : [])).join(""))
      return { stopReason: "end_turn" }
    })
  const connection = app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable))

  return Object.freeze({
    id: "copilot-acp-fixture",
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
    id: "copilot-mcp-relay-fixture",
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
