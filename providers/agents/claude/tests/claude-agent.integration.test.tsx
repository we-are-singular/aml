import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { AcpAgentError, Agent, AmlRuntime, defineTool, evaluate, Tool } from "@aml-jsx/sdk"
import { afterEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { claudeAgent, type ClaudeAgentOptions } from "../src/index.js"

const fixturePath = fileURLToPath(new URL("fixtures/claude-acp-fixture.mjs", import.meta.url))
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

describe("claudeAgent() with a fixture adapter process", () => {
  it("runs one session over stdio with private Claude state that is removed afterward", async () => {
    const fixture = await createFixture("reply")

    const output = await new AmlRuntime({
      agentProvider: fixture.provider({ apiKey: "configured-key", model: "provider-model" }),
    }).evaluate(
      <Agent model="sonnet" system="Follow the system.">
        Initial
      </Agent>
    )
    const events = await fixture.events()
    const launch = events.find(event => event.type === "launch")

    expect(output).toBe("fixture reply")
    expect(launch?.env).toMatchObject({
      ANTHROPIC_API_KEY: "configured-key",
      ANTHROPIC_MODEL: "sonnet",
      CLAUDE_CONFIG_DIR: expect.stringContaining(`${path.sep}aml-acp-`),
    })
    expect(launch?.env.HOME).toBe(launch?.env.CLAUDE_CONFIG_DIR)
    // The real adapter only offers login methods to clients that declare terminal auth.
    expect(events.find(event => event.type === "initialize")?.clientCapabilities.auth?.terminal).not.toBe(true)
    expect(events.some(event => event.type === "authenticate")).toBe(false)
    expect(events.find(event => event.type === "new")).toMatchObject({
      cwd: await fixture.realDirectory(),
      meta: { systemPrompt: { append: "Follow the system." } },
    })
    await expect(access(launch?.env.CLAUDE_CONFIG_DIR ?? "")).rejects.toThrow()
  })

  it("calls AML JavaScript Tools and submits a structured result through the MCP bridge", async () => {
    const fixture = await createFixture("tool")
    const Result = z.object({ proof: z.string() })
    const proof = defineTool({
      description: "Return a deterministic proof",
      input: z.object({}),
      name: "claude_proof",
      execute: async () => "tool proof",
    })

    async function StructuredRequest() {
      const result = await evaluate(
        <Agent>
          <Tool use={proof} />
          Call claude_proof and submit its text as the proof.
        </Agent>,
        Result
      )
      return JSON.stringify(result)
    }

    const output = await new AmlRuntime({ agentProvider: fixture.provider() }).evaluate(<StructuredRequest />)
    const events = await fixture.events()

    expect(JSON.parse(output)).toEqual({ proof: "tool proof" })
    expect(events.find(event => event.type === "mcp/tools")?.names).toEqual(["claude_proof", "aml_submit_result"])
    expect(events.find(event => event.type === "mcp/call")?.proof).toBe("tool proof")
    expect(events.find(event => event.type === "mcp/submit")?.isError).toBe(false)
    expect(events.find(event => event.type === "prompt")?.text).toContain("mcp__aml__aml_submit_result")
  })

  it("approves permission requests once without writing project settings", async () => {
    const fixture = await createFixture("permission")

    await new AmlRuntime({ agentProvider: fixture.provider() }).evaluate(<Agent>Run the tests.</Agent>)
    const events = await fixture.events()

    expect(events.find(event => event.type === "permission")?.outcome).toEqual({
      optionId: "allow-once",
      outcome: "selected",
    })
    await expect(access(path.join(fixture.directory, ".claude"))).rejects.toThrow()
  })

  it("cancels an in-flight prompt and releases the adapter process", async () => {
    const fixture = await createFixture("hang")
    const controller = new AbortController()
    const evaluation = new AmlRuntime({ agentProvider: fixture.provider() }).evaluate(<Agent>Wait.</Agent>, {
      signal: controller.signal,
    })

    await fixture.waitFor("prompt")
    controller.abort(new Error("stop the fixture"))

    await expect(evaluation).rejects.toThrow()
    const launch = (await fixture.events()).find(event => event.type === "launch")
    await expect(access(launch?.env.CLAUDE_CONFIG_DIR ?? "")).rejects.toThrow()
  })

  it("preserves the adapter's authentication error and releases the scheduler slot", async () => {
    const failing = await createFixture("unauthenticated")
    const succeeding = await createFixture("reply")
    let outcomes: PromiseSettledResult<string>[] = []

    async function Probe() {
      outcomes = await Promise.allSettled([
        evaluate(
          <Agent name="unauthenticated" provider={failing.provider()}>
            Prompt
          </Agent>
        ),
        evaluate(
          <Agent name="next" provider={succeeding.provider()}>
            Prompt
          </Agent>
        ),
      ])
      return "probe complete"
    }

    await expect(new AmlRuntime({ maxConcurrentAgents: 1 }).evaluate(<Probe />)).resolves.toBe("probe complete")

    expect(outcomes[1]).toEqual({ status: "fulfilled", value: "fixture reply" })
    expect(outcomes[0]?.status).toBe("rejected")
    if (outcomes[0]?.status !== "rejected") throw new Error("Expected the unauthenticated fixture to fail")
    expect(outcomes[0].reason.message).toContain('Agent "claude" [name: "unauthenticated"]')
    expect(outcomes[0].reason.cause).toBeInstanceOf(AcpAgentError)
    expect(outcomes[0].reason.cause.message).toContain("Authentication required")
  })

  it("reports a missing adapter command with provider identity before any ACP work", async () => {
    const directory = await temporaryDirectory()

    await expect(
      new AmlRuntime({
        agentProvider: claudeAgent({
          command: path.join(directory, "missing-claude-agent-acp"),
          workingDirectory: directory,
        }),
      }).evaluate(<Agent>Prompt</Agent>)
    ).rejects.toThrow('Agent "claude"')
  })
})

const liveTest = process.env.AML_CLAUDE_ACP_LIVE === "1" ? it : it.skip

describe("claudeAgent() with the published adapter", () => {
  liveTest(
    "runs Claude through the published ACP adapter on the trusted local launcher",
    async () => {
      const workspace = await temporaryDirectory()
      const output = await new AmlRuntime({ agentProvider: liveProvider(workspace) }).evaluate(
        <Agent>Reply with exactly: Hello from ACP</Agent>,
        { signal: AbortSignal.timeout(120_000) }
      )

      expect(output.trim()).toBe("Hello from ACP")
    },
    180_000
  )

  liveTest(
    "removes write and shell tools for a restricted Agent",
    async () => {
      const workspace = await temporaryDirectory()
      const target = path.join(workspace, "forbidden.txt")

      await new AmlRuntime({ agentProvider: liveProvider(workspace) }).evaluate(
        <Agent permissions={{ filesystem: "read-only", network: false, shell: false }}>
          Try to create the file `{target}` containing "written". If you have no tool that can do it, reply exactly:
          unavailable
        </Agent>,
        { signal: AbortSignal.timeout(120_000) }
      )

      await expect(access(target)).rejects.toThrow()
    },
    180_000
  )
})

function liveProvider(workspace: string): ReturnType<typeof claudeAgent> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (apiKey === undefined && oauthToken === undefined) {
    throw new Error("Claude live test requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN")
  }

  return claudeAgent({
    ...(apiKey === undefined ? { oauthToken: oauthToken! } : { apiKey }),
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.91.0"],
    command: "npx",
    model: process.env.AML_CLAUDE_MODEL ?? "haiku",
    workingDirectory: workspace,
  })
}

interface FixtureEvent {
  readonly type: string
  readonly [key: string]: any
}

async function createFixture(mode: string) {
  const directory = await temporaryDirectory()
  const log = path.join(directory, "events.jsonl")
  const events = async (): Promise<FixtureEvent[]> => {
    const content = await readFile(log, "utf8").catch(() => "")
    return content
      .split("\n")
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as FixtureEvent)
  }

  return {
    directory,
    events,
    provider(options: ClaudeAgentOptions = {}) {
      return claudeAgent({
        ...options,
        args: [fixturePath],
        command: process.execPath,
        env: { AML_CLAUDE_FIXTURE_LOG: log, AML_CLAUDE_FIXTURE_MODE: mode },
        workingDirectory: directory,
      })
    },
    async realDirectory() {
      const { realpath } = await import("node:fs/promises")
      return await realpath(directory)
    },
    async waitFor(type: string) {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if ((await events()).some(event => event.type === type)) return
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw new Error(`Fixture did not record ${type}`)
    },
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aml-claude-acp-"))
  directories.push(directory)
  return directory
}
