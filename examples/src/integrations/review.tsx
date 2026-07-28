import { Agent, defineTool, evaluate, Tool } from "@aml-jsx/sdk"
import { z } from "zod"

import { createReviewProvider } from "../shared/create-review-provider.js"

const REVIEW_FIXTURE = `
export interface InvoiceLine {
  price: number
}

export function calculateInvoiceTotal(lines: InvoiceLine[]): number {
  return lines.reduce((total, line) => total + line.price, 0) / lines.length
}
`.trim()

/**
 * Selects the Agent harness once so the AML workflow remains provider-agnostic.
 */
const ExampleProvider = createReviewProvider(process.env.AML_REVIEW_PROVIDER ?? "deterministic")

/**
 * Gives each specialist the same complete source fixture through a typed Tool.
 */
const ExampleTool = defineTool({
  description: "Read the complete TypeScript review fixture",
  input: z.object({}),
  name: "read_review_fixture",
  async execute() {
    return REVIEW_FIXTURE
  },
})

/**
 * Resolves independent specialists before authoring the synthesis Agent.
 */
async function ReviewWorkflow() {
  const [correctness, maintainability] = await Promise.all([
    evaluate(
      <Agent
        provider={ExampleProvider}
        system="You are a correctness reviewer. Report only concrete defects supported by the supplied code."
      >
        <Tool use={ExampleTool} />
        Call read_review_fixture, inspect its complete result, and report the highest-confidence correctness problem.
      </Agent>
    ),
    evaluate(
      <Agent
        provider={ExampleProvider}
        system="You are a maintainability reviewer. Prefer direct, proportionate improvements over speculative abstraction."
      >
        <Tool use={ExampleTool} />
        Call read_review_fixture, inspect its complete result, and report the most useful maintainability observation.
      </Agent>
    ),
  ])

  return (
    <Agent provider={ExampleProvider} system="You synthesize code-review evidence without inventing findings.">
      Correctness reviewer:
      {correctness}
      Maintainability reviewer:
      {maintainability}
      Return one concise final review. End with the exact marker AML_REVIEW_COMPLETE.
    </Agent>
  )
}

/**
 * Demonstrates one multi-agent workflow running through interchangeable
 * deterministic, OpenCode, and Codex providers.
 */
export default function ReviewExample() {
  return <ReviewWorkflow />
}
