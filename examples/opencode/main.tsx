import { opencodeAgent } from "@aml/agent-opencode"
import { Agent, AmlRuntime } from "@aml/sdk"

const provider = opencodeAgent({
  model: process.env.AML_OPENCODE_MODEL ?? "opencode-go/minimax-m3",
  server: { port: 0, timeout: 15_000 },
})

try {
  const output = await new AmlRuntime({
    agentProvider: provider,
  }).evaluate(
    <Agent>
      Reply with exactly AML_OPENCODE_OK and no other text.
    </Agent>,
  )

  if (output.trim() !== "AML_OPENCODE_OK") {
    throw new Error(`Unexpected OpenCode output: ${output}`)
  }

  console.log(output)
} finally {
  await provider.close()
}
