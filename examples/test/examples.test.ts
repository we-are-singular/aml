import { describe, expect, test } from "vitest"

import { AmlRuntime, type AmlRenderable } from "@aml-jsx/sdk"

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
})
