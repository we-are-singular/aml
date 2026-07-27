import {
  Agent,
  defineMcpServer,
  FollowUp,
  Mcp,
  Tool,
} from "@aml/sdk"
import { DeterministicAgentProvider } from "@aml/sdk/testing"

/**
 * Gives the example Agent one MCP capability alongside its authored Tool.
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
      <Tool name="read" />
      <Mcp use={ExampleMcp} />
      Investigate the implementation.
      <FollowUp>Challenge the evidence.</FollowUp>
      <FollowUp>Produce the review.</FollowUp>
    </Agent>
  )
}
