import { randomUUID } from "node:crypto"

import { Agent, AmlRuntime, defineTool, Tool } from "@aml/sdk"
import { expect, it } from "vitest"
import { z } from "zod"

import { opencodeAgent } from "../src/index.js"

const liveTest =
  process.env.AML_OPENCODE_LIVE === "1" ? it : it.skip

liveTest(
  "runs one credentialed opencode-go Agent with a JavaScript Tool",
  async () => {
    const secret = randomUUID()
    let calls = 0
    const revealProof = defineTool({
      description: "Return the private AML integration proof value",
      input: z.object({}),
      name: "reveal_aml_proof",
      async execute() {
        calls += 1
        return secret
      },
    })
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
          <Tool use={revealProof} />
          Call the reveal_aml_proof tool. Reply with exactly the value
          returned by the tool and no other text.
        </Agent>,
      )

      expect(output.trim()).toBe(secret)
      expect(calls).toBe(1)
    } finally {
      await provider.close()
    }
  },
  120_000,
)
