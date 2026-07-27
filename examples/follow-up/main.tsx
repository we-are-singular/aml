import {
  Agent,
  AmlRuntime,
  defineAgentProvider,
  defineMcpServer,
  FollowUp,
  Mcp,
  Tool,
} from "@aml/sdk"

const project = defineMcpServer({
  name: "project",
  transport: {
    type: "streamable-http",
    url: "https://example.com/mcp",
  },
})
const sessions: string[][] = []
const provider = defineAgentProvider({
  name: "follow-up-example",

  /**
   * Emulates one provider-owned conversation over the complete AML turn plan.
   */
  async run(request) {
    const turns = [request.prompt, ...(request.followUps ?? [])]

    if (
      request.tools.length !== 1 ||
      request.mcpServers.length !== 1
    ) {
      throw new Error(
        "Expected one session-wide Tool and MCP capability",
      )
    }

    sessions.push(turns)
    return { text: `final:${turns.at(-1)}` }
  },
})

const output = await new AmlRuntime({
  agentProvider: provider,
}).evaluate(
  <Agent>
    <Tool name="read" />
    <Mcp use={project} />
    Investigate the implementation.
    <FollowUp>Challenge the evidence.</FollowUp>
    <FollowUp>Produce the review.</FollowUp>
  </Agent>,
)

if (output !== "final:Produce the review.") {
  throw new Error(`Unexpected FollowUp output: ${output}`)
}

if (
  JSON.stringify(sessions) !==
  JSON.stringify([
    [
      "Investigate the implementation.",
      "Challenge the evidence.",
      "Produce the review.",
    ],
  ])
) {
  throw new Error("FollowUps did not use one authored session plan")
}

console.log(`${output} turns=${sessions[0]?.length}`)
