import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  Agent,
  AmlRuntime,
  Sandbox,
  Workspace,
  type AgentExecutionContext,
  type AgentProvider,
  type AgentRequest,
  type SandboxSession,
} from "@aml/sdk"
import { DeterministicSandboxProvider } from "@aml/sdk/testing"
import { localWorkspace } from "@aml/workspace-local"

interface LocalSandboxHandle {
  readonly directory: string
}

const directory = await mkdtemp(
  path.join(tmpdir(), "aml-local-workspace-example-"),
)
const workspaceProvider = localWorkspace({ directory })
const sandboxProvider =
  new DeterministicSandboxProvider<LocalSandboxHandle>({
    createHandle(request) {
      if (request.workspace === undefined) {
        throw new Error(
          "Local example Sandbox requires a Workspace materialization",
        )
      }

      return { directory: request.workspace.directory }
    },
  })

/**
 * Demonstrates local durability without coupling AML to Node filesystem APIs.
 */
class LocalWorkspaceAgent implements AgentProvider {
  readonly name = "local-workspace-example"

  /**
   * Accepts the deterministic same-host Sandbox handle used by this example.
   */
  supportsSandbox(
    sandbox: SandboxSession,
  ): sandbox is SandboxSession<LocalSandboxHandle> {
    const handle = sandbox.lease.handle as Partial<LocalSandboxHandle>
    return (
      typeof handle === "object" &&
      handle !== null &&
      typeof handle.directory === "string"
    )
  }

  /**
   * Writes during one evaluation and reads the same file during the next.
   */
  async run(
    request: AgentRequest,
    context: AgentExecutionContext,
  ): Promise<{ text: string }> {
    const sandbox = context.sandbox

    if (sandbox === undefined || !this.supportsSandbox(sandbox)) {
      throw new Error("Local Workspace Agent requires its Sandbox")
    }

    const finding = path.join(
      sandbox.lease.handle.directory,
      "finding.txt",
    )

    if (request.prompt === "write") {
      await writeFile(finding, "shared finding")
      return { text: "persisted" }
    }

    return {
      text: await readFile(finding, "utf8"),
    }
  }
}

const runtime = new AmlRuntime({
  agentProvider: new LocalWorkspaceAgent(),
})

try {
  const first = await runtime.evaluate(
    <Workspace id="review-42" provider={workspaceProvider}>
      <Sandbox provider={sandboxProvider}>
        <Agent>write</Agent>
      </Sandbox>
    </Workspace>,
  )
  const second = await runtime.evaluate(
    <Workspace id="review-42" provider={workspaceProvider}>
      <Sandbox provider={sandboxProvider}>
        <Agent>read</Agent>
      </Sandbox>
    </Workspace>,
  )
  const output = `${first}:${second}`

  if (output !== "persisted:shared finding") {
    throw new Error(`Unexpected local Workspace output: ${output}`)
  }

  console.log(output)
} finally {
  await rm(directory, { force: true, recursive: true })
  await rm(`${directory}.lock`, {
    force: true,
    recursive: true,
  })
}
