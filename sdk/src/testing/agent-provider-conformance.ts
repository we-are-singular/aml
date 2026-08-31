import type { AgentProvider } from "../components/agent/agent-provider.js"
import type { AgentRequest } from "../components/agent/agent-request.js"
import type { AgentResponse } from "../components/agent/agent-response.js"
import { validateAgentProvider } from "../components/agent/validate-agent-provider.js"
import { createAgentExecutionContext } from "./create-agent-execution-context.js"

/**
 * Exercises the provider-neutral Agent call boundary without a test-runner
 * dependency.
 *
 * The check runs one request containing an initial prompt and FollowUp, requires
 * a string response, then verifies that a pre-cancelled context rejects with the
 * exact AbortSignal reason. A real provider may perform external work during the
 * first call; supply isolated credentials and infrastructure in integration
 * tests. The promise resolves only when every assertion passes.
 *
 * @param provider Provider instance to validate and exercise.
 */
export async function agentProviderConformance(provider: AgentProvider): Promise<void> {
  const validatedProvider = validateAgentProvider(provider)

  const trace = Object.freeze({
    runId: "agent-provider-conformance",
    spanId: "agent-provider-conformance",
  })
  const request: AgentRequest = Object.freeze({
    // FollowUp is part of the stable session contract, so every provider
    // conformance run exercises more than one authored input.
    followUps: Object.freeze(["agent-provider-conformance-final"]),
    mcpServers: Object.freeze([]),
    permissions: Object.freeze({ filesystem: "read-write", network: true, shell: true }),
    prompt: "agent-provider-conformance",
    system: "Follow the provider contract.",
    tools: Object.freeze([]),
    trace,
  })
  const context = createAgentExecutionContext({
    trace,
  })
  const response: AgentResponse = await Reflect.apply(validatedProvider.run, validatedProvider.provider, [
    request,
    context,
  ])

  if (typeof response !== "object" || response === null || typeof response.text !== "string") {
    throw new TypeError("Agent provider must return a text response")
  }

  const cancellation = new Error("agent-provider-conformance-cancelled")
  const controller = new AbortController()
  controller.abort(cancellation)

  try {
    await Reflect.apply(validatedProvider.run, validatedProvider.provider, [
      request,
      createAgentExecutionContext({
        signal: controller.signal,
        trace: Object.freeze({
          runId: "agent-provider-conformance-cancelled",
          spanId: "agent-provider-conformance-cancelled",
        }),
      }),
    ])
  } catch (error) {
    if (error === cancellation) {
      return
    }

    throw new TypeError("Agent provider must reject pre-cancelled execution with the AbortSignal reason", {
      cause: error,
    })
  }

  throw new TypeError("Agent provider must reject pre-cancelled execution")
}
