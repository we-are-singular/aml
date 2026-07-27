import {
  Agent,
  AmlRuntime,
  defineMcpServer,
  Mcp,
} from "@aml/sdk"
import { DeterministicAgentProvider } from "@aml/sdk/testing"

const project = defineMcpServer({
  name: "project",
  transport: {
    type: "streamable-http",
    url: "https://example.com/mcp",
  },
})
const provider = new DeterministicAgentProvider({
  /**
   * Proves MCP grants are provider data scoped to one Agent, not prompt text.
   */
  respond(request, _context, callIndex) {
    if (callIndex === 0) {
      const [server] = request.mcpServers

      if (
        request.prompt !== "Inspect the project." ||
        server?.kind !== "configured" ||
        server.definition !== project
      ) {
        throw new Error("Configured MCP grant did not reach its Agent")
      }

      return { text: "attached" }
    }

    if (
      request.prompt !== "Summarize without capabilities." ||
      request.mcpServers.length !== 0
    ) {
      throw new Error("MCP grant leaked into a sibling Agent")
    }

    return { text: "isolated" }
  },
})
const output = await new AmlRuntime({
  agentProvider: provider,
}).evaluate([
  <Agent>
    <Mcp use={project} />
    Inspect the project.
  </Agent>,
  ":",
  <Agent>Summarize without capabilities.</Agent>,
])

if (output !== "attached:isolated") {
  throw new Error(`Unexpected MCP output: ${output}`)
}

console.log(output)
