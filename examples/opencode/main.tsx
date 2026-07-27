import { randomUUID } from "node:crypto"

import { opencodeAgent } from "@aml/agent-opencode"
import { Agent, AmlRuntime, defineTool, Tool } from "@aml/sdk"
import { z } from "zod"

// A random value proves the model received data by calling this process-local
// JavaScript function rather than guessing a value from the authored prompt.
const secret = randomUUID()
let calls = 0
const revealProof = defineTool({
  description: "Return the private AML example proof value",
  input: z.object({}),
  name: "reveal_aml_proof",
  async execute() {
    calls += 1
    return secret
  },
})
const provider = opencodeAgent({
  model: process.env.AML_OPENCODE_MODEL ?? "opencode-go/minimax-m3",
  server: { port: 0, timeout: 15_000 },
})

try {
  // The example intentionally exercises only the package's public dist exports.
  const output = await new AmlRuntime({
    agentProvider: provider,
  }).evaluate(
    <Agent>
      <Tool use={revealProof} />
      Call the reveal_aml_proof tool. Reply with exactly the value
      returned by the tool and no other text.
    </Agent>,
  )

  if (output.trim() !== secret || calls !== 1) {
    throw new Error(`Unexpected OpenCode output: ${output}`)
  }

  console.log("AML_OPENCODE_TOOL_OK")
} finally {
  await provider.close()
}
