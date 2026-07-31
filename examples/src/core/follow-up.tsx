import { Agent, defineMcpServer, FollowUp, Mcp } from "@aml-jsx/sdk"
import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"

/**
 * Gives the example Agent one explicit MCP capability.
 */
const ExampleMcp = defineMcpServer({
  name: "project",
  transport: {
    type: "streamable-http",
    url: "https://example.com/mcp",
  },
})

/**
 * Returns the final authored turn from one complete provider session plan.
 */
const ExampleProvider = new DeterministicAgentProvider({
  name: "follow-up-example",
  respond(request) {
    const turns = [request.prompt, ...(request.followUps ?? [])]
    return { text: `final:${turns.at(-1)}` }
  },
})

/**
 * Demonstrates several authored turns in one provider-owned Agent session.
 */
export default function FollowUpExample() {
  return (
    <Agent provider={ExampleProvider}>
      <Mcp use={ExampleMcp} />
      Investigate the implementation.
      <FollowUp>Challenge the evidence.</FollowUp>
      <FollowUp>Produce the review.</FollowUp>
    </Agent>
  )
}
