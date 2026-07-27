import { Agent, System } from "@aml/sdk"
import { DeterministicAgentProvider } from "@aml/sdk/testing"

/**
 * Produces one reusable review rule for the parent Agent's system prompt.
 */
const SpecialistProvider = new DeterministicAgentProvider({
  name: "specialist",
  respond: () => ({ text: "Prefer evidence over speculation." }),
})

/**
 * Represents the parent harness receiving resolved child Agent output.
 */
const ExampleProvider = new DeterministicAgentProvider({
  name: "coordinator",
  respond: () => ({ text: "Review complete." }),
})

/**
 * Demonstrates child Agent output contributing to a parent system prompt.
 */
export default function AgentExample() {
  return (
    <Agent
      provider={ExampleProvider}
      model="coordinator/deep"
      system="Coordinate a review."
    >
      <System>
        <Agent provider={SpecialistProvider}>Generate one review rule.</Agent>
      </System>
      Review this change.
    </Agent>
  )
}
