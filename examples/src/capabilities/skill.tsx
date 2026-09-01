import { fileURLToPath } from "node:url"

import { Agent, Skill } from "@aml-jsx/sdk"
import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"

/**
 * Stands in for any Agent harness so the example can focus on Skill authorship.
 */
const ExampleProvider = new DeterministicAgentProvider({
  respond: () => ({ text: "Skill resolved." }),
})

/**
 * Demonstrates a complete local Skill package registered for one Agent.
 */
export default function SkillExample() {
  return (
    <Agent provider={ExampleProvider}>
      <Skill src={fileURLToPath(new URL("./skills/evidence-review", import.meta.url))} />
      Review the change.
    </Agent>
  )
}
