import { randomUUID } from "node:crypto"

import { Agent, AmlRuntime, defineTool, evaluate, FollowUp, Tool } from "@aml-jsx/sdk"
import { expect, it } from "vitest"
import { z } from "zod"

import { piAgent } from "../src/index.js"

const liveTest = process.env.AML_PI_LIVE === "1" ? it : it.skip
const model = process.env.AML_PI_MODEL ?? "opencode-go/glm-5.1"

liveTest(
  "returns hello world from a real Pi-backed model",
  async () => {
    const apiKey = process.env.OPENCODE_API_KEY
    const provider = piAgent({
      model,
      ...(apiKey === undefined ? {} : { providers: { "opencode-go": { apiKey } } }),
    })
    const output = await new AmlRuntime({ agentProvider: provider }).evaluate(
      <Agent>Reply with exactly: Hello, world!</Agent>
    )

    expect(output.trim()).toBe("Hello, world!")
  },
  180_000
)

liveTest(
  "retains conversation history across real Pi FollowUps",
  async () => {
    const secret = randomUUID()
    const apiKey = process.env.OPENCODE_API_KEY
    const provider = piAgent({
      model,
      ...(apiKey === undefined ? {} : { providers: { "opencode-go": { apiKey } } }),
    })
    const output = await new AmlRuntime({ agentProvider: provider }).evaluate(
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
  "runs a real Pi Agent with an AML JavaScript Tool",
  async () => {
    const expected = randomUUID()
    let calls = 0
    const lookup = defineTool({
      description: "Return the exact live-test fixture",
      input: z.object({}),
      name: "lookup_pi_fixture",
      async execute() {
        calls += 1
        return expected
      },
    })
    const apiKey = process.env.OPENCODE_API_KEY
    const provider = piAgent({
      model,
      ...(apiKey === undefined ? {} : { providers: { "opencode-go": { apiKey } } }),
    })
    const output = await new AmlRuntime({ agentProvider: provider }).evaluate(
      <Agent>
        <Tool use={lookup} />
        Call lookup_pi_fixture and return only its result.
      </Agent>
    )

    expect(output.trim()).toBe(expected)
    expect(calls).toBe(1)
  },
  180_000
)

liveTest(
  "returns schema-validated JSON from a real Pi Agent",
  async () => {
    const expected = randomUUID()
    const Result = z.object({
      count: z.number().int(),
      proof: z.string(),
    })
    const apiKey = process.env.OPENCODE_API_KEY
    const provider = piAgent({
      model,
      ...(apiKey === undefined ? {} : { providers: { "opencode-go": { apiKey } } }),
    })

    async function StructuredProof() {
      const result = await evaluate(
        <Agent provider={provider}>
          Set the proof field to the exact literal string "{expected}" and the count field to the integer 7.
        </Agent>,
        Result
      )

      return `${result.proof}:${result.count}`
    }

    await expect(new AmlRuntime().evaluate(<StructuredProof />)).resolves.toBe(`${expected}:7`)
  },
  180_000
)
