import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk"
import {
  Agent,
  AmlRuntime,
  defineTool,
  evaluate,
  Sandbox,
  Skill,
  Tool,
  type AmlRenderable,
  type AmlTraceEvent,
  type SandboxProcess,
} from "@aml-jsx/sdk"
import { DeterministicSandboxProvider } from "@aml-jsx/sdk/testing"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { claudeAgent, type ClaudeAgentOptions } from "../src/index.js"

describe("claudeAgent()", () => {
  it("lets the Agent own ACP while the Sandbox only spawns its process", async () => {
    const spawned: Array<{
      args: readonly string[]
      command: string
      options: Readonly<{ cwd?: string; env?: Readonly<Record<string, string>> }>
    }> = []
    const traceEvents: AmlTraceEvent[] = []
    const sandboxProvider = new DeterministicSandboxProvider({
      exec: command => ({ exitCode: 0, stderr: "", stdout: command === "pwd" ? "/sandbox/repository\n" : "" }),
      spawn(command, args, _request, options) {
        spawned.push({ args, command, options })
        return completedProcess()
      },
    })
    const provider = claudeAgent({
      apiKey: "configured-key",
      args: ["--hide-claude-auth"],
      command: "custom-claude-acp",
      env: { ANTHROPIC_API_KEY: "ignored", CLAUDE_CONFIG_DIR: "/ignored", EXTRA: "value", HOME: "/ignored" },
      model: "provider-model",
    })

    await expect(
      new AmlRuntime({ agentProvider: provider, trace: event => traceEvents.push(event) }).evaluate(
        <Sandbox access="read-write" cwd="repository" provider={sandboxProvider}>
          <Agent model="claude-sonnet-test">Initial</Agent>
        </Sandbox>
      )
    ).rejects.toThrow()

    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({
      args: ["--hide-claude-auth"],
      command: "custom-claude-acp",
      options: {
        cwd: "repository",
        env: {
          ANTHROPIC_API_KEY: "configured-key",
          ANTHROPIC_MODEL: "claude-sonnet-test",
          CLAUDE_CONFIG_DIR: expect.stringMatching(/^\/tmp\/aml-acp-[^/]+$/),
          EXTRA: "value",
          HOME: expect.stringMatching(/^\/tmp\/aml-acp-[^/]+$/),
        },
      },
    })
    expect(spawned[0]?.options.env?.CLAUDE_CONFIG_DIR).toBe(spawned[0]?.options.env?.HOME)
    expect(
      traceEvents
        .filter(event => event.type === "event" && event.name === "sandbox.process")
        .map(event => event.attributes.state)
    ).toEqual(["spawn_requested", "started", "kill_requested", "kill_completed", "exited"])
    expect(JSON.stringify(traceEvents)).not.toContain("custom-claude-acp")
    expect(JSON.stringify(traceEvents)).not.toContain("configured-key")
  })

  it("uses the provider model only when the Agent does not override it", async () => {
    expect((await captureSandboxLaunch({ model: "provider-model" })).env.ANTHROPIC_MODEL).toBe("provider-model")
    expect((await captureSandboxLaunch()).env.ANTHROPIC_MODEL).toBeUndefined()
  })

  it("injects an explicit OAuth token and never forwards credentials it was not given", async () => {
    const withToken = await captureSandboxLaunch({ env: { CLAUDE_CODE_OAUTH_TOKEN: "ignored" }, oauthToken: "token" })
    const withoutCredentials = await captureSandboxLaunch()

    expect(withToken.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("token")
    expect(withToken.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(withoutCredentials.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(withoutCredentials.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it("points CLAUDE_CONFIG_DIR at the canonical staged Skills root", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "aml-claude-skill-"))

    try {
      await mkdir(path.join(directory, "review"))
      await writeFile(
        path.join(directory, "review", "SKILL.md"),
        "---\nname: review\ndescription: Review code.\n---\n\n# Review\n"
      )
      const launch = await captureSandboxLaunch(
        {},
        <Agent>
          <Skill src="./review" />
        </Agent>,
        directory
      )

      expect(launch.env.CLAUDE_CONFIG_DIR).toMatch(/^\/tmp\/aml-agent-[^/]+\/\.agents$/u)
      expect(launch.env.HOME).toMatch(/^\/tmp\/aml-acp-[^/]+$/u)
      expect(JSON.stringify(launch.meta ?? {})).not.toContain("Available skill")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("appends AML system instructions to Claude Code's system prompt instead of the first turn", async () => {
    const launch = await captureSandboxLaunch({}, <Agent system="Follow the authored system.">Initial</Agent>)

    expect(launch.meta).toEqual({ systemPrompt: { append: "Follow the authored system." } })
    expect(launch.prompts).toEqual(["Initial"])
  })

  it("sends no session metadata for default permissions and options", async () => {
    const launch = await captureSandboxLaunch()

    expect(launch.meta).toBeUndefined()
  })

  it("maps narrowed permissions to Claude Code disallowed tools", async () => {
    const readOnly = await captureSandboxLaunch(
      {},
      <Agent permissions={{ filesystem: "read-only", network: true, shell: true }}>Prompt</Agent>
    )
    const restricted = await captureSandboxLaunch(
      {},
      <Agent permissions={{ filesystem: "read-only", network: false, shell: false }}>Prompt</Agent>
    )

    expect(readOnly.meta).toEqual({ claudeCode: { options: { disallowedTools: ["Edit", "Write", "NotebookEdit"] } } })
    expect(restricted.meta).toEqual({
      claudeCode: {
        options: { disallowedTools: ["Edit", "Write", "NotebookEdit", "Bash", "WebFetch", "WebSearch"] },
      },
    })
  })

  it("forwards arbitrary reasoning effort as a Claude Agent SDK option", async () => {
    const launch = await captureSandboxLaunch({ reasoningEffort: "xhigh" })

    expect(launch.meta).toEqual({ claudeCode: { options: { effort: "xhigh" } } })
  })

  it("answers permission requests once so approvals are never persisted", async () => {
    const launch = await captureSandboxLaunch({}, <Agent>Prompt</Agent>, undefined, { requestPermission: true })

    expect(launch.permissionOutcome).toEqual({ optionId: "allow-once", outcome: "selected" })
  })

  it("uses Claude-qualified names for AML JavaScript Tools and structured output", async () => {
    const Result = z.object({ status: z.literal("done") })
    const proof = defineTool({
      description: "Return a deterministic proof",
      input: z.object({}),
      name: "claude_proof",
      execute: async () => "proof",
    })
    async function StructuredRequest() {
      await evaluate(
        <Agent system="Follow the authored system.">
          <Tool use={proof} />
          Call claude_proof and submit the result.
        </Agent>,
        Result
      )
      return "unreachable"
    }

    const captured = await captureSandboxLaunch({}, <StructuredRequest />, undefined, {
      expectError: 'Agent "claude"',
    })

    expect(captured.mcpServers).toEqual(["aml"])
    expect(captured.meta).toEqual({
      systemPrompt: {
        append:
          "Follow the authored system.\n\n" +
          "AML JavaScript Tools use these Claude Code MCP tool names:\n- claude_proof: mcp__aml__claude_proof",
      },
    })
    expect(captured.prompts).toHaveLength(2)
    expect(captured.prompts[0]).not.toContain("Follow the authored system.")
    expect(captured.prompts[0]).toContain('Call the Claude Code MCP tool "mcp__aml__aml_submit_result" once')
    expect(captured.prompts[1]).toContain("The previous turn ended without submitting a valid structured result.")
    expect(captured.prompts[1]).toContain('Call the Claude Code MCP tool "mcp__aml__aml_submit_result" once')
  })

  it("never calls ACP authenticate because credentials travel in the environment", async () => {
    const launch = await captureSandboxLaunch({ apiKey: "configured-key" })

    expect(launch.authenticated).toBe(false)
  })

  it("validates and snapshots options before external work", async () => {
    expect(() => claudeAgent({ command: " claude-agent-acp " })).toThrow(
      "Claude command must be a non-empty normalized string"
    )
    expect(() => claudeAgent({ model: "" })).toThrow("Claude model must be a non-empty normalized string")
    expect(() => claudeAgent({ args: ["a\0b"] })).toThrow("Claude args must be strings without null bytes")
    expect(() => claudeAgent({ env: [] as unknown as Record<string, string> })).toThrow("Claude env must be an object")
    expect(() => claudeAgent({ apiKey: "key", oauthToken: "token" })).toThrow(
      "Claude apiKey and oauthToken cannot both be set"
    )
    expect(() => claudeAgent(null as unknown as ClaudeAgentOptions)).toThrow("Claude Agent options must be an object")

    const args = ["--first"]
    const env: Record<string, string> = { EXTRA: "before" }
    const provider = claudeAgent({ args, env })
    args.push("--mutated")
    env.EXTRA = "after"
    const launch = await captureSandboxLaunch({}, undefined, undefined, { provider })

    expect(launch.args).toEqual(["--first"])
    expect(launch.env.EXTRA).toBe("before")
  })
})

interface CapturedLaunch {
  readonly args: readonly string[]
  readonly authenticated: boolean
  readonly env: Readonly<Record<string, string>>
  readonly mcpServers: readonly string[]
  readonly meta: Readonly<Record<string, unknown>> | null | undefined
  readonly permissionOutcome: unknown
  readonly prompts: readonly string[]
}

/**
 * Runs one Agent against an in-memory ACP fixture and records the launch
 * contract the Claude profile produced.
 */
async function captureSandboxLaunch(
  options: ClaudeAgentOptions = {},
  tree: AmlRenderable = <Agent>Prompt</Agent>,
  cwd?: string,
  behavior: {
    readonly expectError?: string
    readonly provider?: ReturnType<typeof claudeAgent>
    readonly requestPermission?: boolean
  } = {}
): Promise<Readonly<CapturedLaunch>> {
  let args: readonly string[] = []
  let authenticated = false
  let env: Readonly<Record<string, string>> = {}
  let mcpServers: readonly string[] = []
  let meta: Readonly<Record<string, unknown>> | null | undefined
  let permissionOutcome: unknown
  const prompts: string[] = []
  const sandboxProvider = new DeterministicSandboxProvider({
    exec: command => ({ exitCode: 0, stderr: "", stdout: command === "pwd" ? "/sandbox/repository\n" : "" }),
    spawn(command, spawnArgs, _request, spawnOptions) {
      if (command === "node") return relayFixtureProcess()

      args = spawnArgs
      env = spawnOptions.env ?? {}
      return acpFixtureProcess({
        onAuthenticate() {
          authenticated = true
        },
        onNewSession(servers, sessionMeta) {
          mcpServers = servers.map(server => server.name)
          meta = sessionMeta
        },
        onPermission(outcome) {
          permissionOutcome = outcome
        },
        onPrompt(prompt) {
          prompts.push(prompt)
        },
        requestPermission: behavior.requestPermission === true,
      })
    },
  })
  const evaluation = new AmlRuntime({
    agentProvider: behavior.provider ?? claudeAgent(options),
    ...(cwd === undefined ? {} : { cwd }),
  }).evaluate(
    <Sandbox access="read-write" provider={sandboxProvider}>
      {tree}
    </Sandbox>
  )

  if (behavior.expectError === undefined) {
    await evaluation
  } else {
    await expect(evaluation).rejects.toThrow(behavior.expectError)
  }

  return { args, authenticated, env, mcpServers, meta, permissionOutcome, prompts }
}

function acpFixtureProcess(hooks: {
  readonly onAuthenticate: () => void
  readonly onNewSession: (
    servers: readonly { readonly name: string }[],
    meta: Readonly<Record<string, unknown>> | null | undefined
  ) => void
  readonly onPermission: (outcome: unknown) => void
  readonly onPrompt: (prompt: string) => void
  readonly requestPermission: boolean
}): Readonly<SandboxProcess> {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const app = agent({ name: "claude-test" })
    .onRequest(methods.agent.initialize, ({ params }) => ({
      agentCapabilities: { mcpCapabilities: { http: true, sse: true } },
      authMethods: [],
      protocolVersion: params.protocolVersion,
    }))
    .onRequest(methods.agent.authenticate, () => {
      hooks.onAuthenticate()
      return {}
    })
    .onRequest(methods.agent.session.new, ({ params }) => {
      hooks.onNewSession(params.mcpServers, params._meta)
      return { sessionId: "claude-test-session" }
    })
    .onRequest(methods.agent.session.prompt, async ({ params }) => {
      hooks.onPrompt(params.prompt.flatMap(block => (block.type === "text" ? [block.text] : [])).join(""))

      if (hooks.requestPermission) {
        const response = await connection.client.request(methods.client.session.requestPermission, {
          options: [
            { kind: "allow_always", name: "Always allow", optionId: "allow-with-updates" },
            { kind: "allow_once", name: "Allow", optionId: "allow-once" },
            { kind: "reject_once", name: "Reject", optionId: "reject" },
          ],
          sessionId: params.sessionId,
          toolCall: { title: "Run tests", toolCallId: "claude-test-tool-call" },
        })
        hooks.onPermission(response.outcome)
      }

      await connection.client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { content: { text: "fixture reply", type: "text" }, sessionUpdate: "agent_message_chunk" },
      })
      return { stopReason: "end_turn" }
    })
  const connection = app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable))

  return Object.freeze({
    id: "claude-acp-fixture",
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
    id: "claude-mcp-relay-fixture",
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

function completedProcess(): Readonly<SandboxProcess> {
  return Object.freeze({
    id: "claude-acp-process",
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
  return new ReadableStream<Uint8Array>({ start: controller => controller.close() })
}
