import {
  Agent,
  AmlRuntime,
  evaluate,
  type AgentProvider,
} from "@aml/sdk"

let active = 0
let maxActive = 0

const provider: AgentProvider = {
  name: "concurrency-example",

  /**
   * Makes completion order differ from authored result order.
   */
  async run(request) {
    active += 1
    maxActive = Math.max(maxActive, active)

    try {
      if (request.prompt === "review") {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { text: "review-result" }
      }

      if (request.prompt === "audit") {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { text: "audit-result" }
      }

      return { text: `synthesized:${request.prompt}` }
    } finally {
      active -= 1
    }
  },
}

/**
 * Starts independent specialists explicitly, then runs one coordinator.
 */
async function Review() {
  const [review, audit] = await Promise.all([
    evaluate(<Agent>review</Agent>),
    evaluate(<Agent>audit</Agent>),
  ])

  return <Agent>combine:{review}|{audit}</Agent>
}

const output = await new AmlRuntime({
  agentProvider: provider,
  maxConcurrentAgents: 2,
}).evaluate(<Review />)

if (
  output !==
  "synthesized:combine:review-result|audit-result"
) {
  throw new Error(`Unexpected concurrency output: ${output}`)
}

if (maxActive !== 2) {
  throw new Error(`Expected two active specialists, observed ${maxActive}`)
}

console.log(`${output} peak=${maxActive}`)
