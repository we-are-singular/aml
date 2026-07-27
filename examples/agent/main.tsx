import { Agent, AmlRuntime, System } from "@aml/sdk"
import { DeterministicAgentProvider } from "@aml/sdk/testing"

const specialist = new DeterministicAgentProvider({
  name: "specialist",
  respond: () => ({ text: "Prefer evidence over speculation." }),
})
const coordinator = new DeterministicAgentProvider({
  name: "coordinator",
  respond(request) {
    if (request.system !== "Coordinate a review.\nPrefer evidence over speculation.") {
      throw new Error(`Unexpected system prompt: ${request.system}`)
    }

    if (request.prompt !== "Review this change.") {
      throw new Error(`Unexpected prompt: ${request.prompt}`)
    }

    return { text: "Review complete." }
  },
})

const output = await new AmlRuntime({
  agentProvider: coordinator,
  system: "Coordinate a review.",
}).evaluate(
  <Agent model="coordinator/deep">
    <System>
      <Agent provider={specialist}>Generate one review rule.</Agent>
    </System>
    Review this change.
  </Agent>,
)

if (output !== "Review complete.") {
  throw new Error(`Unexpected Agent output: ${output}`)
}

console.log(output)
