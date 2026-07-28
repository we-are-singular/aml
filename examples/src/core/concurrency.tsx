import { Agent, evaluate } from "@aml-jsx/sdk"
import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"

/**
 * Finishes specialists out of order so the example can show authored ordering.
 */
const ExampleProvider = new DeterministicAgentProvider({
  name: "concurrency-example",
  async respond(request) {
    if (request.prompt === "review") {
      await new Promise(resolve => setTimeout(resolve, 30))
      return { text: "review-result" }
    }

    if (request.prompt === "audit") {
      await new Promise(resolve => setTimeout(resolve, 5))
      return { text: "audit-result" }
    }

    return { text: `synthesized:${request.prompt}` }
  },
})

/**
 * Starts independent specialists explicitly, then authors one coordinator.
 */
async function Review() {
  const [review, audit] = await Promise.all([
    evaluate(<Agent provider={ExampleProvider}>review</Agent>),
    evaluate(<Agent provider={ExampleProvider}>audit</Agent>),
  ])

  return (
    <Agent provider={ExampleProvider}>
      combine:{review}|{audit}
    </Agent>
  )
}

/**
 * Demonstrates explicit parallel discovery followed by ordered synthesis.
 */
export default function ConcurrencyExample() {
  return <Review />
}
