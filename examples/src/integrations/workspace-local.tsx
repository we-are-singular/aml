import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Agent, evaluate, Sandbox, Workspace } from "@aml-jsx/sdk"

import { createLocalWorkspaceFixture } from "../shared/create-local-workspace-fixture.js"

/**
 * Demonstrates a local Workspace persisting files across Sandbox leases.
 */
export default function LocalWorkspaceExample() {
  return <LocalWorkspaceRun />
}

/**
 * Owns the temporary directory inside AML's active component boundary.
 */
async function LocalWorkspaceRun() {
  const directory = await mkdtemp(join(tmpdir(), "aml-workspace-local-"))
  const {
    agent: ExampleProvider,
    sandbox: ExampleSandbox,
    workspace: ExampleWorkspace,
  } = createLocalWorkspaceFixture(directory)

  try {
    return await evaluate(
      <Workspace id="review-42" provider={ExampleWorkspace}>
        <Sandbox provider={ExampleSandbox}>
          <Agent provider={ExampleProvider}>write</Agent>
        </Sandbox>
        <Sandbox provider={ExampleSandbox}>
          <Agent provider={ExampleProvider}>read</Agent>
        </Sandbox>
      </Workspace>
    )
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}
