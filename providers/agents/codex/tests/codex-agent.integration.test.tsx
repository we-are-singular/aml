import { randomUUID } from "node:crypto"

import { Agent, AmlRuntime, defineTool, evaluate, FollowUp, Tool } from "@aml-jsx/sdk"
import { expect, it } from "vitest"
import { z } from "zod"

import { codexAgent } from "../src/index.js"

const liveTest = process.env.AML_CODEX_LIVE === "1" ? it : it.skip
const model = process.env.AML_CODEX_MODEL ?? "gpt-5.3-codex-spark"

liveTest(
  "retains conversation history across real Codex FollowUps",
  async () => {
    const secret = randomUUID()
    const provider = codexAgent({ model })
    const output = await new AmlRuntime({
      agentProvider: provider,
    }).evaluate(
      <Agent>
        Remember the exact token "{secret}". Reply only with acknowledged.
        <FollowUp>Return only the exact token from the preceding message.</FollowUp>
      </Agent>
    )

    expect(output.trim()).toBe(secret)
  },
  180_000
)

liveTest(
  "runs a real Codex Agent with an AML JavaScript Tool",
  async () => {
    const expectedLabel = randomUUID()
    let calls = 0
    const lookupLabel = defineTool({
      description: "Look up the current JavaScript Tool fixture label",
      input: z.object({}),
      name: "lookup_aml_fixture_label",
      async execute() {
        calls += 1
        return expectedLabel
      },
    })
    const provider = codexAgent({ model })
    const output = await new AmlRuntime({
      agentProvider: provider,
    }).evaluate(
      <Agent>
        <Tool use={lookupLabel} />
        Use lookup_aml_fixture_label and return only its exact result.
      </Agent>
    )

    expect(output.trim()).toBe(expectedLabel)
    expect(calls).toBe(1)
  },
  180_000
)

liveTest(
  "returns schema-validated structured output from a real Codex Agent",
  async () => {
    const secret = randomUUID()
    const Result = z.object({
      count: z.number().int(),
      proof: z.string(),
    })
    const provider = codexAgent({ model })

    async function StructuredProof() {
      const result = await evaluate(
        <Agent>Return proof "{secret}" and count 7 as the requested structured result.</Agent>,
        Result
      )

      return `${result.proof}:${result.count}`
    }

    await expect(new AmlRuntime({ agentProvider: provider }).evaluate(<StructuredProof />)).resolves.toBe(`${secret}:7`)
  },
  180_000
)
