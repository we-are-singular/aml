import { type AML, Agent, Block, Parallel, type AgentProvider } from "@aml-jsx/sdk"
import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"

/** Composes two independent specialists before the editor receives their results. */
export const ReleaseBrief: AML.Component<{ provider: AgentProvider; change: string }> = ({ provider, change }) => {
  return (
    <Agent provider={provider} name="release-editor" system="Write a release brief from the supplied findings.">
      <Parallel>
        <Block tag="user-impact">
          <Agent provider={provider} name="impact-specialist" system="Explain the user impact.">
            {change}
          </Agent>
        </Block>
        <Block tag="rollout-checks">
          <Agent provider={provider} name="rollout-specialist" system="List checks before rollout.">
            {change}
          </Agent>
        </Block>
      </Parallel>
    </Agent>
  )
}

const ExampleProvider = new DeterministicAgentProvider({
  respond(request) {
    if (request.system === "Explain the user impact.") {
      return { text: "Users can export their invoices as CSV." }
    }
    if (request.system === "List checks before rollout.") {
      return { text: "Check account permissions and CSV escaping." }
    }

    // Echo the editor's input so the example exposes the actual resolved dataflow.
    return { text: request.prompt }
  },
})

/** Demonstrates a reusable agent team without credentials or model calls. */
export default function AgentTeamExample(): AML {
  return <ReleaseBrief provider={ExampleProvider} change="Add CSV export to the invoice list." />
}
