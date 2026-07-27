import {
  Agent,
  Sandbox,
  Workspace,
} from "@aml/sdk"

import { createWorkspaceFixture } from "../shared/create-workspace-fixture.js"

/**
 * Keeps provider wiring outside the AML component users are meant to read.
 */
const {
  agent: ExampleProvider,
  sandbox: ExampleSandbox,
  workspace: ExampleWorkspace,
} = createWorkspaceFixture()

/**
 * Demonstrates disposable Sandboxes sharing one durable Workspace.
 */
export default function WorkspaceExample() {
  return (
    <Workspace id="review-42" provider={ExampleWorkspace}>
      <Sandbox access="read-write" provider={ExampleSandbox}>
        <Agent provider={ExampleProvider}>write</Agent>
      </Sandbox>
      <Sandbox access="read-only" provider={ExampleSandbox}>
        <Agent provider={ExampleProvider}>observed</Agent>
      </Sandbox>
    </Workspace>
  )
}
