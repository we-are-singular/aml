import { codexAgent } from "@aml/agent-codex"
import {
  Agent,
  AmlRuntime,
  createConsoleTracer,
  type AgentProvider,
  type AmlTraceEvent,
  type TraceSink,
} from "@aml/sdk"
import { DeterministicAgentProvider } from "@aml/sdk/testing"

const PRIVATE_PROMPT = [
  "Reply with exactly AML_OBSERVABILITY_LIVE_OK.",
  "Do not add punctuation or explanation.",
].join(" ")

/**
 * Selects a real provider only for the explicit credentialed proof command.
 */
function createProvider(name: string): AgentProvider {
  if (name === "codex") {
    return codexAgent({
      model:
        process.env.AML_CODEX_MODEL ??
        "gpt-5.3-codex-spark",
    })
  }

  if (name !== "deterministic") {
    throw new TypeError(
      `Unsupported observability provider "${name}"`,
    )
  }

  return new DeterministicAgentProvider({
    respond: () => ({ text: "AML_OBSERVABILITY_LIVE_OK" }),
  })
}

const events: AmlTraceEvent[] = []
const consoleTrace = createConsoleTracer()
const trace = ((event: AmlTraceEvent) => {
  events.push(event)
  consoleTrace(event)
}) as TraceSink
const providerName =
  process.env.AML_OBSERVABILITY_PROVIDER ?? "deterministic"
const output = await new AmlRuntime({
  agentProvider: createProvider(providerName),
  trace,
}).evaluate(<Agent>{PRIVATE_PROMPT}</Agent>)

if (output.trim() !== "AML_OBSERVABILITY_LIVE_OK") {
  throw new Error(
    `Unexpected ${providerName} observability output: ${output}`,
  )
}

// The provider-neutral Agent span must be a child of the evaluation root, and
// the default consumer must not receive authored or model-generated content.
const evaluation = events.find(
  (event) =>
    event.type === "span.start" &&
    event.kind === "evaluation",
)
const agent = events.find(
  (event) =>
    event.type === "span.start" && event.kind === "agent",
)

if (
  evaluation === undefined ||
  agent?.parentSpanId !== evaluation.spanId
) {
  throw new Error("Observability spans were not attributable")
}

if (
  JSON.stringify(events).includes(PRIVATE_PROMPT) ||
  JSON.stringify(events).includes(output)
) {
  throw new Error(
    "Default observability events exposed prompt content",
  )
}

console.log(
  `AML_OBSERVABILITY_${providerName.toUpperCase()}_OK`,
)
