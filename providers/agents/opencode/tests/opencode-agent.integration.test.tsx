import { randomUUID } from "node:crypto"
import { access, rm } from "node:fs/promises"

import { Agent, type AmlTraceEvent, AmlRuntime, evaluate, FollowUp } from "@aml-jsx/sdk"
import { expect, it } from "vitest"
import { z } from "zod"

import { opencodeAgent } from "../src/index.js"

const liveTest = process.env.AML_OPENCODE_LIVE === "1" ? it : it.skip

liveTest(
  "does not let a native task subagent widen restricted Agent permissions",
  async () => {
    const outsidePath = `/tmp/aml-opencode-native-task-${randomUUID()}`
    const childMarker = randomUUID()
    const provider = opencodeAgent({
      directory: process.cwd(),
      model: process.env.AML_OPENCODE_MODEL ?? "opencode-go/deepseek-v4-flash",
    })

    try {
      const output = await new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent permissions={{ filesystem: "read-only", network: false, shell: false }}>
          Use the native task tool to start the general subagent. Tell the subagent to attempt the shell command `touch
          {outsidePath}`, then return exactly the marker `{childMarker}` whether the command succeeds or fails. After
          the subagent completes, return its marker.
        </Agent>,
        { signal: AbortSignal.timeout(30_000) }
      )

      await expect(access(outsidePath)).rejects.toThrow()
      expect(output).toContain(childMarker)
    } finally {
      await rm(outsidePath, { force: true })
    }
  },
  45_000
)

liveTest(
  "retains conversation history through the installed native OpenCode ACP Agent",
  async () => {
    const secret = randomUUID()
    const provider = opencodeAgent({
      directory: process.cwd(),
      model: process.env.AML_OPENCODE_MODEL ?? "opencode-go/deepseek-v4-flash",
    })

    const output = await new AmlRuntime({ agentProvider: provider }).evaluate(
      <Agent>
        Remember the exact token "{secret}". Reply only with acknowledged.
        <FollowUp>Return only the exact token from the preceding message.</FollowUp>
      </Agent>,
      { signal: AbortSignal.timeout(30_000) }
    )

    expect(output.trim()).toBe(secret)
  },
  45_000
)

liveTest(
  "delivers non-empty system instructions without stalling the ACP session",
  async () => {
    const provider = opencodeAgent({
      directory: process.cwd(),
      model: process.env.AML_OPENCODE_MODEL ?? "opencode-go/deepseek-v4-flash",
    })

    const output = await new AmlRuntime({ agentProvider: provider }).evaluate(
      <Agent system="Reply concisely and follow the supplied instructions.">Reply with exactly: ready</Agent>,
      { signal: AbortSignal.timeout(30_000) }
    )

    expect(output.trim()).toBe("ready")
  },
  45_000
)

liveTest(
  "retains non-empty system instructions through follow-up structured output",
  async () => {
    const proof = randomUUID()
    const Result = z.object({ proof: z.string() })
    const provider = opencodeAgent({
      directory: process.cwd(),
      model: process.env.AML_OPENCODE_MODEL ?? "opencode-go/deepseek-v4-flash",
    })

    async function StructuredProof() {
      const result = await evaluate(
        <Agent system="Return only what each user message explicitly requests.">
          Remember the exact token "{proof}". Reply only with acknowledged.
          <FollowUp>Submit the exact token as the structured proof.</FollowUp>
        </Agent>,
        Result
      )

      return result.proof
    }

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(<StructuredProof />, {
        signal: AbortSignal.timeout(30_000),
      })
    ).resolves.toBe(proof)
  },
  45_000
)

liveTest(
  "runs repository shell tools with non-empty system instructions",
  async () => {
    const events: AmlTraceEvent[] = []
    const provider = opencodeAgent({
      directory: process.cwd(),
      model: process.env.AML_OPENCODE_MODEL ?? "opencode-go/deepseek-v4-flash",
    })

    const output = await new AmlRuntime({ agentProvider: provider, trace: event => events.push(event) }).evaluate(
      <Agent system="Run the requested command before answering and return only its output.">
        Run `git rev-parse --is-inside-work-tree` in the repository.
      </Agent>,
      { signal: AbortSignal.timeout(30_000) }
    )

    expect(output.trim()).toBe("true")
    expect(events.every(event => !Object.hasOwn(event.attributes, "update"))).toBe(true)
    expect(
      events.some(
        event =>
          event.type === "event" &&
          event.name === "acp.session.update" &&
          event.attributes.sessionUpdate === "tool_call"
      )
    ).toBe(true)
  },
  45_000
)
