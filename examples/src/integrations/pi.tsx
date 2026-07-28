import { randomUUID } from "node:crypto"

import { Agent, defineTool, piAgent, Tool } from "@aml-jsx/sdk"
import { z } from "zod"

const proof = randomUUID()
const ExampleTool = defineTool({
  description: "Return the private AML Pi example proof value",
  input: z.object({}),
  name: "reveal_aml_pi_proof",
  async execute() {
    return proof
  },
})

/**
 * Uses Pi's embedded SDK with an explicitly configured OpenCode Go provider.
 */
const ExampleProvider = piAgent({
  model: process.env.AML_PI_MODEL ?? "opencode-go/glm-5.1",
  ...(process.env.OPENCODE_API_KEY === undefined
    ? {}
    : {
        providers: { "opencode-go": { apiKey: process.env.OPENCODE_API_KEY } },
      }),
})

/**
 * Demonstrates a credentialed Pi session calling a process-local Tool.
 */
export default function PiExample() {
  return (
    <Agent provider={ExampleProvider}>
      <Tool use={ExampleTool} />
      You must call reveal_aml_pi_proof. Reply with exactly its result and no other text.
    </Agent>
  )
}
