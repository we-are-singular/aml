import {
  Agent,
  AmlRuntime,
  Loop,
  type AgentProvider,
  type AgentJavaScriptTool,
} from "@aml/sdk"
import { z } from "zod"

const ResearchState = z.object({
  done: z.boolean(),
  findings: z.array(z.string()),
})
const prompts: string[] = []
const provider: AgentProvider = {
  name: "loop-example",

  /**
   * Emulates a model staging progress before a fresh summarization session.
   */
  async run(request, context) {
    prompts.push(request.prompt)

    if (request.prompt === "investigate") {
      const stateTool = request.tools.find(
        (tool): tool is AgentJavaScriptTool =>
          tool.kind === "javascript" &&
          tool.name === "aml_set_state",
      )

      if (!stateTool) {
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
}

const output = await new AmlRuntime({
  agentProvider: provider,
}).evaluate(
  <Loop
    initial={{ done: false, findings: [] }}
    name="research"
    render={({ state }) => (
      <Agent>
        {state.done ? state.findings.join(", ") : "investigate"}
      </Agent>
    )}
    schema={ResearchState}
  />,
)

if (
  output !==
    "final:state commits after this session" ||
  JSON.stringify(prompts) !==
    JSON.stringify([
      "investigate",
      "state commits after this session",
    ])
) {
  throw new Error("Loop did not commit into a fresh Agent iteration")
}

console.log(`${output} sessions=${prompts.length}`)
