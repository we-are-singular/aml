import { randomUUID } from "node:crypto"

import { Agent, defineTool, opencodeAgent, Tool } from "@aml-jsx/sdk"
import { z } from "zod"

// The random value proves the model called this process-local Tool rather than
// inferring a constant from the authored prompt.
const proof = randomUUID()
const ExampleTool = defineTool({
  description: "Return the private AML example proof value",
  input: z.object({}),
  name: "reveal_aml_proof",
  async execute() {
    return proof
  },
})

/**
 * Uses the real OpenCode adapter; AML finalizes its host after evaluation.
 */
const ExampleProvider = opencodeAgent({
  model: process.env.AML_OPENCODE_MODEL ?? "opencode-go/minimax-m3",
  server: { port: 0, timeout: 15_000 },
})

/**
 * Demonstrates a credentialed OpenCode model calling a process-local Tool.
 */
export default function OpenCodeExample() {
  return (
    <Agent provider={ExampleProvider}>
      <Tool use={ExampleTool} />
      Call the reveal_aml_proof tool. Reply with exactly the value returned by the tool and no other text.
    </Agent>
  )
}
