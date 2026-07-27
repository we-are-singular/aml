import { Agent, AmlRuntime, evaluate } from "@aml/sdk"
import { DeterministicAgentProvider } from "@aml/sdk/testing"
import { z } from "zod"

const Finding = z.object({
  severity: z.enum(["low", "high"]),
  summary: z.string(),
})

const provider = new DeterministicAgentProvider({
  /**
   * Emulates one structured specialist followed by one text coordinator.
   */
  respond(request, _context, callIndex) {
    if (callIndex === 0) {
      if (
        request.output?.type !== "json" ||
        request.prompt !== "Inspect the change."
      ) {
        throw new Error("Specialist did not request structured output")
      }

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
 * Uses ordinary async component code to move typed Agent data downstream.
 */
async function Review() {
  const finding = await evaluate(
    <Agent>Inspect the change.</Agent>,
    Finding,
  )

  return (
    <Agent>
      Explain this {finding.severity} finding: {finding.summary}
    </Agent>
  )
}

const output = await new AmlRuntime({
  agentProvider: provider,
}).evaluate(<Review />)

if (
  output !==
  "synthesized:Explain this high finding: authorization is checked after mutation"
) {
  throw new Error(`Unexpected structured output: ${output}`)
}

console.log(output)
