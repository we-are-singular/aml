import { Agent, type AgentProvider } from "@aml-jsx/sdk"

const provider: AgentProvider = {
  name: "cli-test",
  async run(request) {
    return { text: `answer:${request.prompt}` }
  },
}

export default <Agent provider={provider}>trace fixture prompt</Agent>
