import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"
import { z } from "zod"

import {
  Agent,
  AmlRuntime,
  createConsoleTracer,
  defineTool,
  evaluate,
  localWorkspace,
  Sandbox,
  Tool,
  Workspace,
} from "../../src/index.js"

import {
  parseSmokeCommand,
  selectSmokeCases,
  SMOKE_AGENTS,
  SMOKE_SANDBOXES,
  type SmokeAgentInstance,
  type SmokeAgentName,
  type SmokeSandboxName,
} from "./smoke-matrix.js"

const command = parseSmokeCommand([
  ...(process.env.AML_SMOKE_AGENT === undefined ? [] : ["--agent", process.env.AML_SMOKE_AGENT]),
  ...(process.env.AML_SMOKE_SANDBOX === undefined ? [] : ["--sandbox", process.env.AML_SMOKE_SANDBOX]),
])
const selectedCases = selectSmokeCases(command.kind === "run" ? command.selection : {})

describe("Agent x Sandbox smoke matrix", () => {
  for (const testCase of selectedCases) {
    it(`${testCase.agent} x ${testCase.sandbox}`, async () => {
      await runFileProof(testCase.agent, testCase.sandbox)
    }, 300_000)
  }
})

/**
 * Runs one identical model-driven file proof for every matrix cell.
 */
async function runFileProof(agentName: SmokeAgentName, sandboxName: SmokeSandboxName): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `aml-smoke-${agentName}-${sandboxName}-`))
  const input = randomUUID()
  const output = randomUUID()
  const toolProof = randomUUID()
  const Result = z.object({ proof: z.literal(toolProof), status: z.literal("done") })
  const proofTool = defineTool({
    description: "Return the private proof for this AML smoke invocation.",
    input: z.object({}),
    name: "aml_smoke_proof",
    execute: async () => toolProof,
  })
  const agentRegistration = SMOKE_AGENTS[agentName]
  const agent: SmokeAgentInstance = agentRegistration.create()
  const sandboxRegistration = SMOKE_SANDBOXES[sandboxName]
  const sandboxProvider = sandboxRegistration.create()
  const proofCommand = `test "$(cat input.txt)" = "${input}" && printf %s "${output}" > output.txt && test "$(cat output.txt)" = "${output}"`
  const startedAt = performance.now()
  let response: unknown

  await writeFile(path.join(directory, "input.txt"), input)
  console.log(
    `[smoke:start] agent=${agentName} model=${agentRegistration.model} sandbox=${sandboxName} environment=${sandboxRegistration.environment}`
  )

  const runtime = new AmlRuntime({ agentProvider: agent.provider })
  runtime.on(
    "trace",
    createConsoleTracer({
      write: line => console.log(`[smoke:trace] ${line}`),
    })
  )

  async function StructuredProof() {
    const result = await evaluate(
      <Agent model={agentRegistration.model}>
        <Tool use={proofTool} />
        Run this exact shell command in the current Workspace: {proofCommand}. Call aml_smoke_proof, then return the
        requested structured result with status "done" and proof set to the exact Tool result.
      </Agent>,
      Result
    )
    return JSON.stringify(result)
  }

  try {
    response = await runtime.evaluate(
      <Workspace id={`smoke-${agentName}-${sandboxName}-${randomUUID()}`} provider={localWorkspace({ directory })}>
        <Sandbox access="read-write" provider={sandboxProvider}>
          <StructuredProof />
        </Sandbox>
      </Workspace>,
      { signal: AbortSignal.timeout(240_000) }
    )
    const persisted = await readFile(path.join(directory, "output.txt"), "utf8")

    expect(JSON.parse(String(response))).toEqual({ proof: toolProof, status: "done" })
    expect(persisted).toBe(output)
    console.log(
      `[smoke:proof] agent=${agentName} sandbox=${sandboxName} response=done persisted=true bytes=${Buffer.byteLength(persisted)} durationMs=${Math.round(performance.now() - startedAt)}`
    )
  } catch (error) {
    console.error(
      `[smoke:failure] agent=${agentName} sandbox=${sandboxName} durationMs=${Math.round(performance.now() - startedAt)} response=${JSON.stringify(response)} error=${error instanceof Error ? error.message : String(error)}`
    )
    throw error
  } finally {
    try {
      await agent.release?.()
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  }
}
