import { type AgentExecutionContext, type AgentProvider, type AgentRequest, type SandboxSession } from "@aml-jsx/sdk"
import { DeterministicSandboxProvider, DeterministicWorkspaceProvider } from "@aml-jsx/sdk/testing"

interface ReviewWorkspace {
  readonly findings: string[]
}

interface AttachedSandboxHandle {
  readonly acquisition: number
  readonly workspace: ReviewWorkspace
}

/**
 * Builds deterministic providers that demonstrate Workspace attachment.
 */
export function createWorkspaceFixture() {
  const durable: ReviewWorkspace = { findings: [] }
  const workspace = new DeterministicWorkspaceProvider({
    createHandle: () => durable,
  })
  const sandbox = new DeterministicSandboxProvider<AttachedSandboxHandle>({
    createHandle(request, acquisition) {
      if (request.workspace?.handle !== durable) {
        throw new Error("Sandbox did not receive the active Workspace materialization")
      }

      return {
        acquisition,
        workspace: request.workspace.handle as ReviewWorkspace,
      }
    },
  })

  class WorkspaceAgent implements AgentProvider {
    readonly name = "workspace-example"

    supportsSandbox(session: SandboxSession): session is SandboxSession<AttachedSandboxHandle> {
      const handle = session.lease.handle as Partial<AttachedSandboxHandle>
      return (
        typeof handle === "object" &&
        handle !== null &&
        typeof handle.acquisition === "number" &&
        handle.workspace === durable
      )
    }

    async run(request: AgentRequest, context: AgentExecutionContext): Promise<{ text: string }> {
      const session = context.sandbox

      if (session === undefined || !this.supportsSandbox(session)) {
        throw new Error("Workspace Agent requires its attached Sandbox")
      }

      const handle = session.lease.handle

      if (handle.acquisition === 0) {
        handle.workspace.findings.push("shared finding")
        return { text: "wrote" }
      }

      return {
        text: `${request.prompt}:${handle.workspace.findings.join(",")}`,
      }
    }
  }

  return {
    agent: new WorkspaceAgent(),
    sandbox,
    workspace,
  } as const
}
