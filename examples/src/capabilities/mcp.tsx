import { Agent, defineMcpServer, Mcp } from "@aml/sdk"
import { DeterministicAgentProvider } from "@aml/sdk/testing"

/**
 * Describes an MCP server without connecting to it in the AML runtime.
 */
const ExampleMcp = defineMcpServer({
  name: "project",
  transport: {
    type: "streamable-http",
    url: "https://example.com/mcp",
  },
})

/**
 * Reports whether each Agent received only its authored MCP capabilities.
 */
const ExampleProvider = new DeterministicAgentProvider({
  respond(request) {
    if (request.prompt === "Inspect the project.") {
      return {
        text:
          request.mcpServers.length === 1
            ? "MCP attached. "
            : "MCP missing. ",
      }
    }

    return {
      text:
        request.mcpServers.length === 0
          ? "Sibling isolated."
          : "MCP leaked.",
    }
  },
})

/**
 * Demonstrates that MCP grants remain provider data scoped to one Agent.
 */
export default function McpExample() {
  return (
    <>
      <Agent provider={ExampleProvider}>
        <Mcp use={ExampleMcp} />
        Inspect the project.
      </Agent>
      <Agent provider={ExampleProvider}>
        Summarize without capabilities.
      </Agent>
    </>
  )
}
