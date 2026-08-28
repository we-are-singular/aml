import { Agent, Parallel } from "@aml-jsx/sdk"
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
 * Runs one independent specialist and contributes its labeled result.
 */
function ReviewLane() {
  return [<Agent provider={ExampleProvider}>review</Agent>, "|"]
}

/** Runs the second independent specialist. */
function AuditLane() {
  return <Agent provider={ExampleProvider}>audit</Agent>
}

/** Starts both specialists explicitly, then authors one coordinator. */
function Review() {
  return (
    <Agent provider={ExampleProvider}>
      combine:
      <Parallel>
        <ReviewLane />
        <AuditLane />
      </Parallel>
    </Agent>
  )
}

/**
 * Demonstrates explicit parallel discovery followed by ordered synthesis.
 */
export default function ConcurrencyExample() {
  return <Review />
}
