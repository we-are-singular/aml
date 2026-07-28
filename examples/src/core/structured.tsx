import { Agent, evaluate } from "@aml-jsx/sdk"
import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"
import { z } from "zod"

const Finding = z.object({
  severity: z.enum(["low", "high"]),
  summary: z.string(),
})

/**
 * Returns structured data when requested and plain synthesis text otherwise.
 */
const ExampleProvider = new DeterministicAgentProvider({
  respond(request) {
    if (request.output?.type === "json") {
      return {
        structured: {
          severity: "high",
          summary: "authorization is checked after mutation",
        },
        text: "",
      }
    }

    return { text: `synthesized:${request.prompt}` }
  },
})

/**
 * Moves typed specialist output into a later coordinator prompt.
 */
async function Review() {
  const finding = await evaluate(
    //
    <Agent provider={ExampleProvider}>Inspect the change.</Agent>,
    Finding
  )

  return (
    <Agent provider={ExampleProvider}>
      Explain this {finding.severity} finding: {finding.summary}
    </Agent>
  )
}

/**
 * Demonstrates typed Agent data moving into a later text-producing Agent.
 */
export default function StructuredExample() {
  return <Review />
}
