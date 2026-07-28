import { highlightTsx } from "./highlight"

const START_AGENT_SOURCE = `import { opencodeAgent } from "@aml/agent-opencode"
import { Agent, AmlRuntime } from "@aml/sdk"

const OpenCode = opencodeAgent({})
const runtime = new AmlRuntime()
await runtime.evaluate(
  <Agent provider={OpenCode}>Summarize this repository.</Agent>,
)`

/** Keeps the runnable TSX sample on the same grammar and palette as the docs. */
export async function initGettingStarted(): Promise<void> {
  const example = document.querySelector<HTMLElement>("#start-agent")
  if (!example) return

  example.innerHTML = await highlightTsx(START_AGENT_SOURCE)
}
