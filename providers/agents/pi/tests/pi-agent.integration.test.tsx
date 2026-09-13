import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

import { Agent, AmlRuntime, defineTool, evaluate, FollowUp, Tool } from "@aml-jsx/sdk"
import { expect, it } from "vitest"
import { z } from "zod"

import { piAgent } from "../src/index.js"

const liveTest = process.env.AML_PI_LIVE === "1" ? it : it.skip

liveTest(
  "retains conversation history through the installed pi-acp adapter",
  async () => {
    const secret = randomUUID()
    const provider = piAgent({
      model: process.env.AML_PI_MODEL ?? "opencode-go/deepseek-v4-flash",
      workingDirectory: process.cwd(),
    })
    const output = await new AmlRuntime({ agentProvider: provider }).evaluate(
      <Agent system="Return only what each user message explicitly requests.">
        Remember the exact token "{secret}". Reply only with acknowledged.
        <FollowUp>Return only the exact token from the preceding message.</FollowUp>
      </Agent>
    )

    expect(output.trim()).toBe(secret)
  },
  180_000
)

liveTest(
  "returns schema-validated structured output from a real Pi Agent",
  async () => {
    const secret = randomUUID()
    const Result = z.object({
      count: z.number().int(),
      proof: z.string(),
    })
    const provider = piAgent({
      mcpAdapterPath: fileURLToPath(import.meta.resolve("pi-mcp-adapter")),
      model: process.env.AML_PI_MODEL ?? "opencode-go/deepseek-v4-flash",
      workingDirectory: process.cwd(),
    })

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

liveTest(
  "isolates six concurrent structured Pi Agents using a custom MCP server name",
  async () => {
    const proof = randomUUID()
    const reveal = defineTool({
      name: "read_lane_proof",
      description: "Return the private proof for a lane",
      input: z.object({ lane: z.number().int().min(0).max(5) }),
      execute: ({ lane }) => `${proof}:${lane}`,
    })
    const provider = piAgent({
      mcpAdapterPath: fileURLToPath(import.meta.resolve("pi-mcp-adapter")),
      model: process.env.AML_PI_MODEL ?? "opencode-go/deepseek-v4-flash",
      workingDirectory: process.cwd(),
    })
    async function Lanes() {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, lane) =>
          evaluate(
            <Agent name={`lane-${lane}`} timeoutMs={120_000}>
              <Tool use={reveal} />
              Call read_lane_proof with lane {lane}, then submit its exact returned string as proof and {lane} as lane.
            </Agent>,
            z.object({ lane: z.literal(lane), proof: z.literal(`${proof}:${lane}`) })
          )
        )
      )
      return results.map(result => result.proof).join("\n")
    }
    await expect(
      new AmlRuntime({ agentProvider: provider, maxConcurrentAgents: 6, toolPrefix: "review" }).evaluate(<Lanes />)
    ).resolves.toBe(Array.from({ length: 6 }, (_, lane) => `${proof}:${lane}`).join("\n"))
  },
  180_000
)

liveTest(
  "runs a real Pi Agent with an AML JavaScript Tool through the MCP extension",
  async () => {
    const secret = randomUUID()
    let calls = 0
    const reveal = defineTool({
      description: "Return the private AML Pi integration proof",
      input: z.object({}),
      name: "reveal_aml_pi_proof",
      async execute() {
        calls += 1
        return secret
      },
    })
    const provider = piAgent({
      mcpAdapterPath: fileURLToPath(import.meta.resolve("pi-mcp-adapter")),
      model: process.env.AML_PI_MODEL ?? "opencode-go/deepseek-v4-flash",
      workingDirectory: process.cwd(),
    })
    const output = await new AmlRuntime({ agentProvider: provider }).evaluate(
      <Agent>
        <Tool use={reveal} />
        Call reveal_aml_pi_proof and return only its exact result.
      </Agent>
    )

    expect(output.trim()).toBe(secret)
    expect(calls).toBe(1)
  },
  180_000
)
