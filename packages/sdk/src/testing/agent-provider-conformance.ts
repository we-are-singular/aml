import type { AgentExecutionContext } from "../components/agent/agent-execution-context.js"
import type { AgentProvider } from "../components/agent/agent-provider.js"
import type { AgentRequest } from "../components/agent/agent-request.js"
import type { AgentResponse } from "../components/agent/agent-response.js"
import { validateAgentProvider } from "../components/agent/validate-agent-provider.js"

/**
 * Exercises the provider-neutral call boundary without a test-runner dependency.
 */
export async function agentProviderConformance(
  provider: AgentProvider,
): Promise<void> {
  const validatedProvider = validateAgentProvider(provider)

  const trace = Object.freeze({
    runId: "agent-provider-conformance",
    spanId: "agent-provider-conformance",
  })
  const request: AgentRequest = Object.freeze({
    prompt: "agent-provider-conformance",
    system: "Follow the provider contract.",
    tools: Object.freeze([]),
    trace,
  })
  const context: AgentExecutionContext = Object.freeze({
    signal: new AbortController().signal,
    trace,
  })
  const response: AgentResponse = await Reflect.apply(
    validatedProvider.run,
    validatedProvider.provider,
    [request, context],
  )

  if (
    typeof response !== "object" ||
    response === null ||
    typeof response.text !== "string"
  ) {
    throw new TypeError("Agent provider must return a text response")
  }
}
