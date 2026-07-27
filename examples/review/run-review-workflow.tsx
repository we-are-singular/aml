import {
  Agent,
  AmlRuntime,
  defineTool,
  evaluate,
  Tool,
  type AgentProvider,
} from "@aml/sdk"
import { z } from "zod"

const REVIEW_FIXTURE = `
export interface InvoiceLine {
  price: number
}

export function calculateInvoiceTotal(lines: InvoiceLine[]): number {
  return lines.reduce((total, line) => total + line.price, 0) / lines.length
}
`.trim()

/**
 * Runs one provider-neutral parallel review and synthesis workflow.
 */
export async function runReviewWorkflow(
  provider: AgentProvider,
): Promise<Readonly<{ output: string; toolCalls: number }>> {
  let toolCalls = 0
  const readReviewFixture = defineTool({
    description: "Read the complete TypeScript review fixture",
    input: z.object({}),
    name: "read_review_fixture",
    async execute() {
      toolCalls += 1
      return REVIEW_FIXTURE
    },
  })

  /**
   * Resolves both specialist branches before authoring the synthesis Agent.
   */
  async function ReviewWorkflow() {
    const [correctness, maintainability] = await Promise.all([
      evaluate(
        <Agent
          provider={provider}
          system="You are a correctness reviewer. Report only concrete defects supported by the supplied code."
        >
          <Tool use={readReviewFixture} />
          Call read_review_fixture, inspect its complete result, and report the
          highest-confidence correctness problem.
        </Agent>,
      ),
      evaluate(
        <Agent
          provider={provider}
          system="You are a maintainability reviewer. Prefer direct, proportionate improvements over speculative abstraction."
        >
          <Tool use={readReviewFixture} />
          Call read_review_fixture, inspect its complete result, and report the
          most useful maintainability observation.
        </Agent>,
      ),
    ])

    return (
      <Agent
        provider={provider}
        system="You synthesize code-review evidence without inventing findings."
      >
        Correctness reviewer:
        {correctness}

        Maintainability reviewer:
        {maintainability}

        Return one concise final review. End with the exact marker
        AML_REVIEW_COMPLETE.
      </Agent>
    )
  }

  const output = await new AmlRuntime({
    agentProvider: provider,
    maxConcurrentAgents: 2,
  }).evaluate(<ReviewWorkflow />)

  return Object.freeze({ output, toolCalls })
}
