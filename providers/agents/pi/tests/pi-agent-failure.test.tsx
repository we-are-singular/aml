import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { AcpAgentError, Agent, AmlRuntime, evaluate, type AmlTraceEvent } from "@aml-jsx/sdk"
import { expect, it } from "vitest"
import { z } from "zod"

import { piAgent } from "../src/index.js"

// Native errors and usage remain an upstream pi-acp 0.0.33 limitation. AML
// preserves everything the adapter sends without claiming to recover those fields.
it.each(["prompt-error", "assistant-error", "retry-exhausted", "text-only"])(
  "reproduces Pi %s diagnostics loss and verifies cleanup",
  async mode => {
    const directory = await mkdtemp(join(tmpdir(), "aml-issue-13-"))
    const log = join(directory, "requests.jsonl")
    const events: AmlTraceEvent[] = []
    const metadataEvents: AmlTraceEvent[] = []
    const provider = piAgent({
      args: [fileURLToPath(import.meta.resolve("pi-acp"))],
      command: process.execPath,
      env: { AML_PI_FIXTURE_LOG: log, AML_PI_FIXTURE_MODE: mode },
      piCommand: fileURLToPath(new URL("fixtures/pi-rpc-fixture.mjs", import.meta.url)),
      workingDirectory: directory,
    })
    let outcomes: PromiseSettledResult<unknown>[] = []

    async function Probe() {
      // Queue a successful Agent behind the failing one in the same evaluation.
      // Completion proves cleanup released the sole scheduler slot.
      outcomes = await Promise.allSettled([
        evaluate(<Agent name="failing-lane">fixture:failure</Agent>, z.object({ proof: z.string() })),
        evaluate(<Agent name="next-lane">fixture:success</Agent>),
      ])
      return "probe complete"
    }

    try {
      const runtime = new AmlRuntime({
        agentProvider: provider,
        maxConcurrentAgents: 1,
        trace: Object.assign(
          (event: AmlTraceEvent) => {
            events.push(event)
          },
          { captureContent: true as const }
        ),
      })
      runtime.on("trace", event => {
        metadataEvents.push(event)
      })
      await expect(runtime.evaluate(<Probe />)).resolves.toBe("probe complete")
      expect(outcomes[1]).toEqual({ status: "fulfilled", value: "recovered" })
      expect(outcomes[0]?.status).toBe("rejected")
      if (outcomes[0]?.status !== "rejected") throw new Error("Expected the fixture to fail")
      expect(outcomes[0].reason.message).toContain('Agent "pi" [name: "failing-lane"]')
      expect(outcomes[0].reason.cause.message).toBe("ACP Agent did not submit a valid result through aml_submit_result")
      expect(outcomes[0].reason.cause).toBeInstanceOf(AcpAgentError)
      expect(outcomes[0].reason.cause.sessionId).toMatch(/^fixture-/)
      expect(outcomes[0].reason.cause.attempts).toHaveLength(2)

      // pi-acp 0.0.33 reports the original native rejection and the repair as
      // successful end_turn completions, discarding the native error marker.
      const completions = events.filter(event => event.name === "acp.session.prompt.completed")
      expect(completions).toHaveLength(3)
      expect(completions.every(event => event.attributes.stopReason === "end_turn")).toBe(true)
      expect(completions.every(event => event.attributes.usage === undefined)).toBe(true)
      expect(JSON.stringify(events)).not.toContain("ISSUE_13_NATIVE_PROVIDER_FAILURE")
      if (mode === "retry-exhausted") {
        expect(JSON.stringify(events)).toContain("Retry finished, resuming.")
      }
      if (mode === "text-only") {
        expect(
          events.some(
            event => event.name === "acp.session.update" && String(event.attributes.update).includes("completed work")
          )
        ).toBe(true)
        expect(outcomes[0].reason.cause.attempts).toEqual([
          { text: expect.stringContaining('{"proof":"completed work"}'), stopReason: "end_turn" },
          { text: '{"proof":"completed work"}', stopReason: "end_turn" },
        ])
        expect(JSON.stringify(metadataEvents)).not.toContain("completed work")
      }

      const requests = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map(line => JSON.parse(line) as { pid: number; home: string; prompt: string })
      expect(requests).toHaveLength(3)
      for (const request of requests.slice(0, 2)) {
        expect(request.prompt).toContain('Call the mcp tool with server "aml" and tool "aml_submit_result".')
        expect(request.prompt).toContain("If the Tool returns an error, correct the result and retry.")
      }
      expect(new Set(requests.map(request => request.pid)).size).toBe(2)
      expect(events.filter(event => event.name === "sandbox.process").map(event => event.attributes.state)).toEqual([
        "spawn_requested",
        "started",
        "kill_requested",
        "kill_completed",
        "spawn_requested",
        "started",
        "kill_requested",
        "kill_completed",
      ])
      for (const request of requests) {
        await expect(stat(request.home)).rejects.toMatchObject({ code: "ENOENT" })
        await expect
          .poll(() => {
            try {
              process.kill(request.pid, 0)
              return false
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === "ESRCH"
            }
          })
          .toBe(true)
      }
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  },
  15_000
)

it.each(["submit", "invalid-then-valid"])(
  "validates real Pi bridge submissions: %s",
  async mode => {
    const directory = await mkdtemp(join(tmpdir(), "aml-pi-submission-"))
    const log = join(directory, "requests.jsonl")
    const events: AmlTraceEvent[] = []
    const provider = piAgent({
      args: [fileURLToPath(import.meta.resolve("pi-acp"))],
      command: process.execPath,
      env: { AML_PI_FIXTURE_LOG: log, AML_PI_FIXTURE_MODE: mode },
      piCommand: fileURLToPath(new URL("fixtures/pi-rpc-fixture.mjs", import.meta.url)),
      workingDirectory: directory,
    })
    try {
      const runtime = new AmlRuntime({
        agentProvider: provider,
        toolPrefix: "review",
        trace: event => {
          events.push(event)
        },
      })
      await expect(
        runtime.evaluate(<Agent schema={z.object({ proof: z.literal("accepted") })}>Submit a result.</Agent>)
      ).resolves.toBe('{"proof":"accepted"}')
      const logEntries = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map(line => JSON.parse(line))
      expect(logEntries[0].prompt).toContain('For AML JavaScript Tools, set server to "review" in every mcp call.')
      expect(logEntries[0].prompt).toContain('{"server":"review","tool":"aml_submit_result","args":{"result":...}}')
      expect(logEntries.filter(entry => entry.kind === "submission").map(entry => entry.isError)).toEqual(
        mode === "submit" ? [false] : [true, false]
      )
      expect(events.filter(event => event.name === "acp.session.prompt.completed")).toHaveLength(1)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  },
  15_000
)
