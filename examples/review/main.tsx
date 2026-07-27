import { codexAgent } from "@aml/agent-codex"
import { opencodeAgent } from "@aml/agent-opencode"
import type { AgentProvider } from "@aml/sdk"
import { DeterministicAgentProvider } from "@aml/sdk/testing"

import { runReviewWorkflow } from "./run-review-workflow.js"

interface ReviewHarness {
  close(): Promise<void>
  readonly provider: AgentProvider
}

/**
 * Selects only the provider construction around one shared AML workflow.
 */
function createHarness(name: string): ReviewHarness {
  if (name === "codex") {
    return {
      async close() {},
      provider: codexAgent({
        model:
          process.env.AML_CODEX_MODEL ??
          "gpt-5.3-codex-spark",
      }),
    }
  }

  if (name === "opencode") {
    const provider = opencodeAgent({
      model:
        process.env.AML_OPENCODE_MODEL ??
        "opencode-go/minimax-m3",
      server: { port: 0, timeout: 15_000 },
    })

    return {
      close: async () => await provider.close(),
      provider,
    }
  }

  if (name !== "deterministic") {
    throw new TypeError(
      `Unsupported AML review provider "${name}"`,
    )
  }

  const provider = new DeterministicAgentProvider({
    async respond(request, context, callIndex) {
      if (callIndex < 2) {
        const tool = request.tools[0]

        if (tool?.kind !== "javascript") {
          throw new Error(
            "Review specialist did not receive its JavaScript Tool",
          )
        }

        const source = await tool.execute(
          {},
          {
            signal: context.signal,
            trace: context.trace,
          },
        )

        return {
          text:
            callIndex === 0
              ? `calculateInvoiceTotal returns an average instead of a total. Evidence: ${String(source)}`
              : "The function name and implementation disagree; express either total or average directly.",
        }
      }

      return {
        text:
          "calculateInvoiceTotal divides the sum by the line count, so callers receive an average. Remove the division or rename the API to match. AML_REVIEW_COMPLETE",
      }
    },
  })

  return {
    async close() {},
    provider,
  }
}

const providerName =
  process.env.AML_REVIEW_PROVIDER ?? "deterministic"
const harness = createHarness(providerName)

try {
  // Both specialists must call the same process-local function, and the final
  // output must come from the third synthesis Agent.
  const result = await runReviewWorkflow(harness.provider)

  if (
    result.toolCalls !== 2 ||
    !result.output.includes("AML_REVIEW_COMPLETE")
  ) {
    throw new Error(
      `Unexpected ${providerName} review result: ${result.output}`,
    )
  }

  console.log(
    `AML_REVIEW_${providerName.toUpperCase()}_OK`,
  )
} finally {
  await harness.close()
}
