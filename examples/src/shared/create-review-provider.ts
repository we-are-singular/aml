import { type AgentProvider, codexAgent, opencodeAgent } from "@aml-jsx/sdk"
import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"

/**
 * Selects one provider without changing the review workflow that consumes it.
 */
export function createReviewProvider(name: string): AgentProvider {
  if (name === "codex") {
    return codexAgent({
      model: process.env.AML_CODEX_MODEL ?? "gpt-5.6-luna",
      reasoningEffort: "low",
    })
  }

  if (name === "opencode") {
    return opencodeAgent({
      model: process.env.AML_OPENCODE_MODEL ?? "opencode-go/deepseek-v4-flash",
    })
  }

  if (name !== "deterministic") {
    throw new TypeError(`Unsupported AML review provider "${name}"`)
  }

  return new DeterministicAgentProvider({
    async respond(request, context) {
      const tool = request.tools[0]

      if (tool?.kind === "javascript") {
        const source = await tool.execute(
          {},
          {
            signal: context.signal,
            trace: context.trace,
          }
        )

        if (request.system.includes("correctness")) {
          return {
            text: `calculateInvoiceTotal returns an average instead of a total. Evidence: ${String(source)}`,
          }
        }

        return {
          text: "The function name and implementation disagree; express either total or average directly.",
        }
      }

      return {
        text: "calculateInvoiceTotal divides the sum by the line count, so callers receive an average. Remove the division or rename the API to match. AML_REVIEW_COMPLETE",
      }
    },
  })
}
