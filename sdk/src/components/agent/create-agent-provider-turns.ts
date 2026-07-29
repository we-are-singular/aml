import type { AgentProviderTurn } from "./agent-provider-session.js"
import type { AgentRequest } from "./agent-request.js"

/**
 * Normalizes one provider request into the exact authored turn order.
 *
 * Provider adapters may use this independently when they expose a lower-level
 * session test seam outside `AbstractAgentProvider`.
 */
export function createAgentProviderTurns(
  request: AgentRequest,
  providerName: string
): readonly Readonly<AgentProviderTurn>[] {
  const followUps = request.followUps

  if (followUps !== undefined && !Array.isArray(followUps)) {
    throw new TypeError(`Agent provider "${providerName}" followUps must be an array`)
  }

  const prompts = [request.prompt]

  for (const followUp of followUps ?? []) {
    if (typeof followUp !== "string" || followUp.length === 0) {
      throw new TypeError(`Agent provider "${providerName}" followUps must contain non-empty strings`)
    }

    prompts.push(followUp)
  }

  return Object.freeze(
    prompts.map((prompt, index) => {
      const isFinal = index === prompts.length - 1

      return Object.freeze({
        index,
        isFinal,
        ...(isFinal && request.output !== undefined ? { output: request.output } : {}),
        prompt,
      })
    })
  )
}
