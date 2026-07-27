import {
  Agent,
  Loop,
  type AgentJavaScriptTool,
} from "@aml/sdk"
import { DeterministicAgentProvider } from "@aml/sdk/testing"
import { z } from "zod"

const ResearchState = z.object({
  done: z.boolean(),
  findings: z.array(z.string()),
})

/**
 * Commits progress through the Loop-owned state Tool on the first session.
 */
const ExampleProvider = new DeterministicAgentProvider({
  name: "loop-example",
  async respond(request, context) {
    if (request.prompt === "investigate") {
      const stateTool = request.tools.find(
        (tool): tool is AgentJavaScriptTool =>
          tool.kind === "javascript" && tool.name === "aml_set_state",
      )

      if (stateTool === undefined) {
        throw new Error("Loop did not grant aml_set_state")
      }

      await stateTool.execute(
        {
          updates: {
            done: true,
            findings: ["state commits after this session"],
          },
        },
        {
          signal: context.signal,
          trace: context.trace,
        },
      )
      return { text: "stale output" }
    }

    return { text: `final:${request.prompt}` }
  },
})

/**
 * Demonstrates transactional state advancing between fresh Agent sessions.
 */
export default function LoopExample() {
  return (
    <Loop
      initial={{ done: false, findings: [] }}
      name="research"
      render={({ state }) => (
        <Agent provider={ExampleProvider}>
          {state.done ? state.findings.join(", ") : "investigate"}
        </Agent>
      )}
      schema={ResearchState}
    />
  )
}
