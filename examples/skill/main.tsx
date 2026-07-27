import { Agent, AmlRuntime, Skill } from "@aml/sdk"
import { DeterministicAgentProvider } from "@aml/sdk/testing"

const provider = new DeterministicAgentProvider({
  /**
   * Proves the built SDK supplied the exact local Skill text to the Agent.
   */
  respond(request) {
    if (
      request.prompt !==
      "Review with concrete evidence from the implementation.\nReview the change."
    ) {
      throw new Error(`Unexpected Skill prompt: ${request.prompt}`)
    }

    return { text: "Skill resolved." }
  },
})
const runtime = new AmlRuntime({
  agentProvider: provider,
  // Resolve relative Skill paths from this isolated example, not process cwd.
  cwd: import.meta.dirname,
})
const output = await runtime.evaluate(
  <Agent>
    <Skill src="./skills/review.md" />
    Review the change.
  </Agent>,
)

if (output !== "Skill resolved.") {
  throw new Error(`Unexpected Skill output: ${output}`)
}

console.log(output)
