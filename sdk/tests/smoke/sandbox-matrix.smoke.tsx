import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { Agent, AmlRuntime, createConsoleTracer, localWorkspace, Sandbox, Tool, Workspace } from "../../src/index.js"

import {
  parseSmokeCommand,
  selectSmokeCases,
  smokeAgent,
  smokeSandbox,
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
    })
  }
})

/**
 * Runs one identical model-driven file proof for every matrix cell.
 */
async function runFileProof(agentName: SmokeAgentName, sandboxName: SmokeSandboxName): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), `aml-smoke-${agentName}-${sandboxName}-`))
  const input = randomUUID()
  const output = randomUUID()
  const agentRegistration = smokeAgent(agentName)
  const sandboxRegistration = smokeSandbox(sandboxName)
  const agentProvider = agentRegistration.create()
  const sandboxProvider = sandboxRegistration.create(agentName)
  const startedAt = performance.now()

  await writeFile(path.join(directory, "input.txt"), input)
  console.log(
    `[smoke:start] agent=${agentName} model=${agentRegistration.model} sandbox=${sandboxName} environment=${sandboxRegistration.environment(agentName)}`
  )

  const runtime = new AmlRuntime({ agentProvider })
  runtime.on(
    "trace",
    createConsoleTracer({
      write: line => console.log(`[smoke:trace] ${line}`),
    })
  )

  try {
    const result = await runtime.evaluate(
      <Workspace id={`smoke-${agentName}-${sandboxName}-${randomUUID()}`} provider={localWorkspace({ directory })}>
        <Sandbox access="read-write" provider={sandboxProvider}>
          <Agent>
            <Tool name="bash" />
            Use bash to read input.txt and confirm it contains exactly "{input}". Then use bash to create output.txt
            containing exactly "{output}" with no trailing newline. Verify output.txt with bash, then reply with
            exactly: done
          </Agent>
        </Sandbox>
      </Workspace>
    )
    const persisted = await readFile(path.join(directory, "output.txt"), "utf8")

    expect(result).toContain("done")
    expect(persisted).toBe(output)
    console.log(
      `[smoke:proof] agent=${agentName} sandbox=${sandboxName} response=done persisted=true bytes=${Buffer.byteLength(persisted)} durationMs=${Math.round(performance.now() - startedAt)}`
    )
  } catch (error) {
    console.error(
      `[smoke:failure] agent=${agentName} sandbox=${sandboxName} durationMs=${Math.round(performance.now() - startedAt)} error=${errorMessage(error)}`
    )
    throw error
  } finally {
    try {
      await agentRegistration.release(agentProvider)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
