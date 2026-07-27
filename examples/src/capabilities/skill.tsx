import { Agent, Skill } from "@aml/sdk"
import { DeterministicAgentProvider } from "@aml/sdk/testing"

/**
 * Stands in for any Agent harness so the example can focus on Skill authorship.
 */
const ExampleProvider = new DeterministicAgentProvider({
  respond: () => ({ text: "Skill resolved." }),
})

/**
 * Demonstrates inline Skill text resolved as part of its owning Agent prompt.
 */
export default function SkillExample() {
  return (
    <Agent provider={ExampleProvider}>
      <Skill>Review with concrete evidence from the implementation.</Skill>
      Review the change.
    </Agent>
  )
}
