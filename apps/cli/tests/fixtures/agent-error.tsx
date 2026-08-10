import { Agent, type AgentProvider } from "@aml-jsx/sdk"

const provider: AgentProvider = {
  name: "broken-provider",
  async run() {
    throw new Error("provider stderr: model request failed")
  },
}

export default <Agent provider={provider}>Trigger the provider failure.</Agent>
