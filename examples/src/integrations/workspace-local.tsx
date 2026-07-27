import { tmpdir } from "node:os"

import { Agent, Sandbox, Workspace } from "@aml/sdk"

import { createLocalWorkspaceFixture } from "../shared/create-local-workspace-fixture.js"

/**
 * Keeps the real local Workspace wiring outside the AML component itself.
 */
const {
  agent: ExampleProvider,
  sandbox: ExampleSandbox,
  workspace: ExampleWorkspace,
} = createLocalWorkspaceFixture(tmpdir())

/**
 * Demonstrates a local Workspace persisting files across Sandbox leases.
 */
export default function LocalWorkspaceExample() {
  return (
    <Workspace id="review-42" provider={ExampleWorkspace}>
      <Sandbox provider={ExampleSandbox}>
        <Agent provider={ExampleProvider}>write</Agent>
      </Sandbox>
      <Sandbox provider={ExampleSandbox}>
        <Agent provider={ExampleProvider}>read</Agent>
      </Sandbox>
    </Workspace>
  )
}
