import { randomUUID } from "node:crypto"

import { Agent, AmlRuntime, FollowUp } from "@aml-jsx/sdk"
import { expect, it } from "vitest"

import { opencodeAgent } from "../src/index.js"

const liveTest = process.env.AML_OPENCODE_LIVE === "1" ? it : it.skip

liveTest(
  "retains conversation history through the installed native OpenCode ACP Agent",
  async () => {
    const secret = randomUUID()
    const provider = opencodeAgent({
      directory: process.cwd(),
      model: process.env.AML_OPENCODE_MODEL ?? "opencode-go/minimax-m3",
    })

    const output = await new AmlRuntime({ agentProvider: provider }).evaluate(
      <Agent>
        Remember the exact token "{secret}". Reply only with acknowledged.
        <FollowUp>Return only the exact token from the preceding message.</FollowUp>
      </Agent>
    )

    expect(output.trim()).toBe(secret)
  },
  120_000
)
