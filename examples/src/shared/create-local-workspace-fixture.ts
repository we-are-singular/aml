import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import {
  type AgentExecutionContext,
  type AgentProvider,
  type AgentRequest,
  localWorkspace,
  type SandboxSession,
} from "@aml-jsx/sdk"
import { DeterministicSandboxProvider } from "@aml-jsx/sdk/testing"

interface LocalSandboxHandle {
  readonly directory: string
}

/**
 * Builds same-host providers for the local Workspace integration example.
 */
export function createLocalWorkspaceFixture(directory: string) {
  const workspace = localWorkspace({ directory })
  const sandbox = new DeterministicSandboxProvider<LocalSandboxHandle>({
    createHandle(request) {
      if (request.workspace === undefined) {
        throw new Error("Local example Sandbox requires a Workspace materialization")
      }

      return { directory: request.workspace.directory }
    },
  })

  class LocalWorkspaceAgent implements AgentProvider {
    readonly name = "local-workspace-example"

    supportsSandbox(session: SandboxSession): session is SandboxSession<LocalSandboxHandle> {
      const handle = session.lease.handle as Partial<LocalSandboxHandle>
      return typeof handle === "object" && handle !== null && typeof handle.directory === "string"
    }

    async run(request: AgentRequest, context: AgentExecutionContext): Promise<{ text: string }> {
      const session = context.sandbox

      if (session === undefined || !this.supportsSandbox(session)) {
        throw new Error("Local Workspace Agent requires its Sandbox")
      }

      const finding = path.join(session.lease.handle.directory, "aml-workspace-local-example.txt")

      if (request.prompt === "write") {
        await writeFile(finding, "shared finding")
        return { text: "persisted" }
      }

      return { text: await readFile(finding, "utf8") }
    }
  }

  return {
    agent: new LocalWorkspaceAgent(),
    sandbox,
    workspace,
  } as const
}
