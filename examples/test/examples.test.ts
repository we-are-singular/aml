import { describe, expect, test } from "vitest"

import { AmlRuntime, type AmlRenderable } from "@aml-jsx/sdk"

import { createReviewExample } from "../src/integrations/review.js"

interface ExampleModule {
  readonly default: () => AmlRenderable
}

const deterministicExamples = import.meta.glob<ExampleModule>("../src/{capabilities,core,resources}/*.tsx", {
  eager: true,
})

describe("examples", () => {
  for (const [path, module] of Object.entries(deterministicExamples)) {
    const title = path.slice(path.lastIndexOf("/") + 1, -".tsx".length)

    test(title, async () => {
      const output = await new AmlRuntime().evaluate(module.default())

      expect(output).toMatchSnapshot()
    })
  }

  test("review integration", async () => {
    await expect(new AmlRuntime().evaluate(createReviewExample("deterministic"))).resolves.toBe(
      "calculateInvoiceTotal divides the sum by the line count, so callers receive an average. Remove the division or rename the API to match. AML_REVIEW_COMPLETE"
    )
  })
})
