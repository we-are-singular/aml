import { Agent, AmlRuntime } from "@aml/sdk"
import { expect, it } from "vitest"

import { opencodeAgent } from "../src/index.js"

const liveTest =
  process.env.AML_OPENCODE_LIVE === "1" ? it : it.skip

liveTest(
  "runs one credentialed opencode-go Agent",
  async () => {
    const provider = opencodeAgent({
      model:
        process.env.AML_OPENCODE_MODEL ?? "opencode-go/minimax-m3",
      server: { port: 0, timeout: 15_000 },
    })

    try {
      const output = await new AmlRuntime({
        agentProvider: provider,
      }).evaluate(
        <Agent>
          Reply with exactly AML_OPENCODE_OK and no other text.
        </Agent>,
      )

      expect(output.trim()).toBe("AML_OPENCODE_OK")
    } finally {
      await provider.close()
    }
  },
  120_000,
)
