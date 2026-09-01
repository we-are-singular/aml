import { type AgentProvider, codexAgent, opencodeAgent } from "@aml-jsx/sdk"
import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"

/**
 * Selects one provider with the directory containing materialized review evidence.
 */
export function createReviewProvider(name: string, directory: string): AgentProvider {
  if (name === "codex") {
    return codexAgent({
      model: process.env.AML_CODEX_MODEL ?? "gpt-5.6-luna",
      reasoningEffort: "low",
      workingDirectory: directory,
    })
  }

  if (name === "opencode") {
    return opencodeAgent({
      directory,
      model: process.env.AML_OPENCODE_MODEL ?? "opencode-go/deepseek-v4-flash",
    })
  }

  if (name !== "deterministic") {
    throw new TypeError(`Unsupported AML review provider "${name}"`)
  }

  return new DeterministicAgentProvider({
    respond(request) {
      if (request.output?.type === "json") {
        if (
          !request.prompt.includes("<changed-files>") ||
          !request.prompt.includes("<pull-request-diff>") ||
          !request.prompt.includes("src/invoice.ts") ||
          request.skills.length !== 1
        ) {
          throw new Error("Review evidence or Skill registration was not resolved before the specialist Agent")
        }

        if (request.system.includes("correctness")) {
          return {
            structured: {
              line: 6,
              path: "src/invoice.ts",
              severity: "high",
              summary: "calculateInvoiceTotal divides the sum by the line count and returns an average.",
            },
            text: "",
          }
        }

        return {
          structured: {
            line: 6,
            path: "src/invoice.ts",
            severity: "medium",
            summary: "The exported function name and implementation describe different operations.",
          },
          text: "",
        }
      }

      if (
        !/<validated-findings>\n\[[\s\S]*\]\n<\/validated-findings>/u.test(request.prompt) ||
        !/<output-contract>\nReturn one concise final review\./u.test(request.prompt)
      ) {
        throw new Error("Review synthesis sections were not wrapped by named Block boundaries")
      }

      return {
        text: "calculateInvoiceTotal divides the sum by the line count, so callers receive an average. Remove the division or rename the API to match. AML_REVIEW_COMPLETE",
      }
    },
  })
}
