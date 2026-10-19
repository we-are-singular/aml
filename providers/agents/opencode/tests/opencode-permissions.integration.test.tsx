import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import os from "node:os"
import path from "node:path"

import { Agent, AmlRuntime, defineAcpAgentProvider, defineTool, Include, Skill, Tool } from "@aml-jsx/sdk"
import { afterEach, expect, it } from "vitest"
import { z } from "zod"

import { opencodeAgent, type OpenCodeAgentOptions, type OpenCodeConfig } from "../src/index.js"

// Real native tools and ACP, with a local deterministic model instead of paid inference.
const smoke = process.env.AML_OPENCODE_SMOKE === "1" ? it : it.skip
const command =
  process.env.AML_OPENCODE_COMMAND ?? path.resolve(import.meta.dirname, "../../../../node_modules/.bin/opencode")
const fixtures: OpenCodeFixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
})

for (const layer of ["global", "agent"] as const) {
  for (const tool of ["glob", "grep", "read"] as const) {
    smoke(
      `recovers from a denied ${tool} outside the repository with ${layer} permissions`,
      async () => {
        const fixture = await OpenCodeFixture.create()
        const outside =
          tool === "read"
            ? { filePath: path.join(fixture.root, "outside", "proof.txt") }
            : {
                path: path.join(fixture.repository, "..", "outside"),
                pattern: tool === "glob" ? "**/proof.txt" : "OUTSIDE",
              }
        const inside =
          tool === "read"
            ? { filePath: path.join(fixture.repository, "proof.txt") }
            : { pattern: tool === "glob" ? "**/proof.txt" : "INSIDE" }
        fixture.respond = request => {
          const results = toolResults(request)
          if (results.length === 0) return { tool, input: outside }
          expect(results[0]?.content).toMatch(/permission|denied|not allowed/i)
          expect(results[0]?.content).not.toContain("OUTSIDE_PROOF")
          if (results.length === 1) return { tool, input: inside }
          expect(results[1]?.content).toContain(tool === "glob" ? "proof.txt" : "INSIDE_PROOF")
          return "recovered"
        }
        const native: OpenCodeConfig =
          layer === "global"
            ? { permission: { external_directory: "deny" }, tools: { "*": true, task: false } }
            : { agent: { aml: { permission: { external_directory: "deny" }, tools: { "*": true, task: false } } } }

        await expect(
          new AmlRuntime({ agentProvider: fixture.provider(native) }).evaluate(
            <Agent permissions={{ filesystem: "read-only", shell: false, network: false }}>Inspect the fixture.</Agent>,
            { signal: AbortSignal.timeout(20_000) }
          )
        ).resolves.toBe("recovered")

        expect(fixture.requests).toHaveLength(3)
        const offered = fixture.requests[0]?.tools.map(tool => tool.function.name)
        expect(offered).toEqual(expect.arrayContaining(["read", "glob", "grep"]))
        for (const denied of ["bash", "edit", "write", "task", "webfetch", "websearch"]) {
          expect(offered).not.toContain(denied)
        }
      },
      30_000
    )
  }
}

smoke(
  "honors native scalar, granular and legacy tool rules without widening portable denials",
  async () => {
    const fixture = await OpenCodeFixture.create()
    fixture.respond = request => {
      const offered = request.tools.map(tool => tool.function.name)
      expect(offered).toContain("read")
      for (const denied of ["bash", "edit", "write", "task", "glob", "grep", "webfetch", "websearch"]) {
        expect(offered).not.toContain(denied)
      }
      const results = toolResults(request)
      if (results.length === 0)
        return { tool: "read", input: { filePath: path.join(fixture.repository, "blocked.txt") } }
      expect(results[0]?.content).toMatch(/permission|denied|not allowed/i)
      if (results.length === 1) return { tool: "read", input: { filePath: path.join(fixture.repository, "proof.txt") } }
      expect(results[1]?.content).toContain("INSIDE_PROOF")
      return "narrow rules preserved"
    }

    await expect(
      new AmlRuntime({
        agentProvider: fixture.provider({
          permission: "deny",
          tools: { "*": true },
          agent: {
            aml: {
              tools: { read: true, glob: false, grep: false, bash: true, write: true },
              permission: { bash: "allow", "*": "deny", read: { "*": "allow", "*blocked.txt": "deny" } },
            },
          },
        }),
      }).evaluate(
        <Agent permissions={{ filesystem: "read-only", shell: false, network: false }}>Inspect the fixture.</Agent>,
        { signal: AbortSignal.timeout(20_000) }
      )
    ).resolves.toBe("narrow rules preserved")
  },
  30_000
)

smoke(
  "reads only invocation-staged Includes and skills under external deny, retaining JS Tools and structured output",
  async () => {
    const fixture = await OpenCodeFixture.create()
    await mkdir(path.join(fixture.root, "review", "references"), { recursive: true })
    await writeFile(path.join(fixture.root, "include.txt"), "STAGED_INCLUDE_PROOF")
    await writeFile(
      path.join(fixture.root, "review", "SKILL.md"),
      "---\nname: review\ndescription: Review fixtures.\n---\n\nSTAGED_SKILL_PROOF"
    )
    await writeFile(path.join(fixture.root, "review", "references", "guide.txt"), "STAGED_REFERENCE_PROOF")
    let stagedSkillDirectory = ""
    const invoked: string[] = []
    fixture.respond = request => {
      const results = toolResults(request)
      const prompt = JSON.stringify(request.messages)
      if (results.length === 0) {
        const stagedInclude = /Read it at `([^`]+)`/.exec(prompt)?.[1]
        expect(stagedInclude).toContain("/.aml/includes/")
        return { tool: "read", input: { filePath: stagedInclude } }
      }
      expect(results[0]?.content).toContain("STAGED_INCLUDE_PROOF")
      if (results.length === 1) return { tool: "skill", input: { name: "review" } }
      expect(results[1]?.content).toContain("STAGED_SKILL_PROOF")
      stagedSkillDirectory =
        /Base directory for this skill: (?:file:\/\/)?([^\n<]+)/.exec(String(results[1]?.content))?.[1]?.trim() ?? ""
      expect(stagedSkillDirectory).toContain("/.agents/skills/review")
      if (results.length === 2)
        return { tool: "read", input: { filePath: path.join(stagedSkillDirectory, "references/guide.txt") } }
      expect(results[2]?.content).toContain("STAGED_REFERENCE_PROOF")
      if (results.length === 3)
        return { tool: "read", input: { filePath: path.join(stagedSkillDirectory, "../../../unrelated.txt") } }
      expect(results[3]?.content).toMatch(/permission|denied|not allowed/i)
      if (results.length === 4) return { tool: "aml_check_proof", input: { proof: "JS_PROOF" } }
      expect(results[4]?.content).toContain("JS_PROOF")
      if (results.length === 5) return { tool: "aml_aml_submit_result", input: { result: { proof: "complete" } } }
      return "complete"
    }
    const checkProof = defineTool({
      name: "check_proof",
      description: "Check fixture evidence",
      input: z.object({ proof: z.string() }),
      execute: ({ proof }) => {
        invoked.push(proof)
        return proof
      },
    })
    await expect(
      new AmlRuntime({
        cwd: fixture.root,
        agentProvider: fixture.provider({
          tools: { task: false },
          permission: { external_directory: "deny" },
          agent: { aml: { permission: { external_directory: "deny" } } },
        }),
      }).evaluate(
        <Agent
          schema={z.object({ proof: z.string() })}
          permissions={{ filesystem: "read-only", shell: false, network: false }}
        >
          <Include src="./include.txt" maxBytes={1} />
          <Skill src="./review" />
          <Tool use={checkProof} />
          Inspect the fixture and submit the proof.
        </Agent>,
        { signal: AbortSignal.timeout(25_000) }
      )
    ).resolves.toBe('{"proof":"complete"}')
    expect(invoked).toEqual(["JS_PROOF"])
  },
  35_000
)

for (const continueOnDeny of [false, true]) {
  smoke(
    `handles ACP rejection with continue_loop_on_deny=${continueOnDeny} using native semantics`,
    async () => {
      const fixture = await OpenCodeFixture.create()
      fixture.respond = request => {
        const results = toolResults(request)
        if (results.length === 0)
          return { tool: "glob", input: { path: path.join(fixture.root, "outside"), pattern: "**/proof.txt" } }
        expect(results[0]?.content).toMatch(/reject|permission|denied/i)
        if (results.length === 1)
          return { tool: "read", input: { filePath: path.join(fixture.repository, "proof.txt") } }
        expect(results[1]?.content).toContain("INSIDE_PROOF")
        return "recovered after rejection"
      }
      const options = fixture.options({
        tools: { task: false },
        permission: { external_directory: "ask", bash: "deny", edit: "deny", webfetch: "deny", websearch: "deny" },
        experimental: { continue_loop_on_deny: continueOnDeny },
      })
      // The real OpenCode profile auto-approves ask requests. Use the shared ACP
      // lifecycle with explicit rejection to isolate the upstream rejection path.
      const rejectingProvider = defineAcpAgentProvider({
        name: "opencode-rejection-fixture",
        workingDirectory: fixture.repository,
        createLaunch(context) {
          return {
            command,
            args: ["acp", "--pure", "--cwd", context.cwd],
            permissionPolicy: "reject_once",
            configuration: [{ id: "model", value: "fixture/probe" }],
            env: {
              ...options.env,
              OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
              OPENCODE_DB: `${context.stateDirectory}/opencode.db`,
              XDG_DATA_HOME: `${context.stateDirectory}/data`,
              XDG_CONFIG_HOME: `${context.stateDirectory}/config`,
              XDG_CACHE_HOME: `${context.stateDirectory}/cache`,
              XDG_STATE_HOME: `${context.stateDirectory}/state`,
            },
          }
        },
      })
      await expect(
        new AmlRuntime({ agentProvider: rejectingProvider }).evaluate(<Agent>Inspect the fixture.</Agent>, {
          signal: AbortSignal.timeout(20_000),
        })
      ).resolves.toBe(continueOnDeny ? "recovered after rejection" : "")
      expect(fixture.requests).toHaveLength(continueOnDeny ? 3 : 1)
    },
    30_000
  )
}

interface ModelRequest {
  messages: { role: string; content: string }[]
  tools: { function: { name: string } }[]
}

type ModelReply = string | { tool: string; input: Record<string, unknown> }

function toolResults(request: ModelRequest) {
  return request.messages.filter(message => message.role === "tool")
}

/** Owns an isolated checkout and a local OpenAI-compatible streaming model. */
class OpenCodeFixture {
  readonly requests: ModelRequest[] = []
  readonly repository: string
  readonly root: string
  readonly #server: Server
  #baseURL = ""
  respond: (request: ModelRequest) => ModelReply = () => "done"

  private constructor(root: string) {
    this.root = root
    this.repository = path.join(root, "repository")
    this.#server = createServer(async (request, response) => {
      try {
        let body = ""
        for await (const chunk of request) body += chunk
        const input = JSON.parse(body) as ModelRequest
        this.requests.push(input)
        const reply = this.respond(input)
        response.writeHead(200, { "content-type": "text/event-stream" })
        const chunk = (delta: unknown, finish_reason: string | null = null) =>
          response.write(
            `data: ${JSON.stringify({
              id: `fixture-${this.requests.length}`,
              object: "chat.completion.chunk",
              created: 1,
              model: "fixture",
              choices: [{ index: 0, delta, finish_reason }],
            })}\n\n`
          )
        chunk({ role: "assistant" })
        chunk(
          typeof reply === "string"
            ? { content: reply }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: `fixture-call-${this.requests.length}`,
                    type: "function",
                    function: { name: reply.tool, arguments: JSON.stringify(reply.input) },
                  },
                ],
              }
        )
        chunk({}, typeof reply === "string" ? "stop" : "tool_calls")
        response.end("data: [DONE]\n\n")
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { message: String(error) } }))
      }
    })
  }

  static async create(): Promise<OpenCodeFixture> {
    const fixture = new OpenCodeFixture(await mkdtemp(path.join(os.tmpdir(), "aml-opencode-permissions-")))
    fixtures.push(fixture)
    await mkdir(fixture.repository)
    await mkdir(path.join(fixture.root, "outside"))
    await writeFile(path.join(fixture.repository, "proof.txt"), "INSIDE_PROOF")
    await writeFile(path.join(fixture.repository, "blocked.txt"), "BLOCKED_PROOF")
    await writeFile(path.join(fixture.root, "outside", "proof.txt"), "OUTSIDE_PROOF")
    execFileSync("git", ["init", "-q", fixture.repository])
    await new Promise<void>(resolve => fixture.#server.listen(0, "127.0.0.1", resolve))
    const address = fixture.#server.address()
    if (address === null || typeof address === "string") throw new Error("Fixture model did not bind a TCP port")
    fixture.#baseURL = `http://127.0.0.1:${address.port}/v1`
    return fixture
  }

  provider(config: OpenCodeConfig) {
    return opencodeAgent(this.options(config))
  }

  options(config: OpenCodeConfig): OpenCodeAgentOptions {
    return {
      command,
      directory: this.repository,
      model: "fixture/probe",
      env: {
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      },
      config: {
        ...config,
        agent: { ...config.agent, title: { disable: true } },
        small_model: "fixture/probe",
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: this.#baseURL, apiKey: "fixture-only" },
            models: { probe: { name: "Fixture", limit: { context: 128_000, output: 8192 } } },
          },
        },
      },
    }
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections()
    await new Promise<void>((resolve, reject) => this.#server.close(error => (error ? reject(error) : resolve())))
    await rm(this.root, { force: true, recursive: true })
  }
}
