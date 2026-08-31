import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

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
 * Uses Pi's ACP adapter with explicit process environment and MCP extension paths.
 */
const ExampleProvider = piAgent({
  ...(process.env.OPENCODE_API_KEY === undefined ? {} : { env: { OPENCODE_API_KEY: process.env.OPENCODE_API_KEY } }),
  mcpAdapterPath: fileURLToPath(import.meta.resolve("pi-mcp-adapter")),
  model: process.env.AML_PI_MODEL ?? "opencode-go/deepseek-v4-flash",
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
