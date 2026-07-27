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
import {
  DeterministicSandboxProvider,
  DeterministicWorkspaceProvider,
} from "@aml/sdk/testing"

interface ReviewWorkspace {
  readonly findings: string[]
}

interface AttachedSandboxHandle {
  readonly acquisition: number
  readonly workspace: ReviewWorkspace
}

const durable: ReviewWorkspace = { findings: [] }
const workspaceProvider = new DeterministicWorkspaceProvider({
  createHandle: () => durable,
  save(lease) {
    if (lease.handle.findings.length !== 1) {
      throw new Error("Workspace saved an unexpected finding set")
    }
  },
})
const sandboxProvider =
  new DeterministicSandboxProvider<AttachedSandboxHandle>({
    createHandle(request, acquisition) {
      const workspace = request.workspace

      if (workspace === undefined || workspace.handle !== durable) {
        throw new Error(
          "Sandbox did not receive the active Workspace materialization",
        )
      }

      return {
        acquisition,
        workspace: workspace.handle as ReviewWorkspace,
      }
    },
  })

/**
 * Demonstrates two disposable environments sharing one durable materialization.
 */
class WorkspaceAgent implements AgentProvider {
  readonly name = "workspace-example"

  /**
   * Accepts only the deterministic attachment created for this example.
   */
  supportsSandbox(
    sandbox: SandboxSession,
  ): sandbox is SandboxSession<AttachedSandboxHandle> {
    const handle = sandbox.lease.handle as Partial<AttachedSandboxHandle>
    return (
      typeof handle === "object" &&
      handle !== null &&
      typeof handle.acquisition === "number" &&
      handle.workspace === durable
    )
  }

  /**
   * Writes in the first Sandbox and reads the same state in the second.
   */
  async run(
    request: AgentRequest,
    context: AgentExecutionContext,
  ): Promise<{ text: string }> {
    const sandbox = context.sandbox

    if (sandbox === undefined || !this.supportsSandbox(sandbox)) {
      throw new Error("Workspace Agent requires its attached Sandbox")
    }

    const handle = sandbox.lease.handle

    if (handle.acquisition === 0) {
      handle.workspace.findings.push("shared finding")
      return { text: "wrote" }
    }

    return {
      text: `${request.prompt}:${handle.workspace.findings.join(",")}`,
    }
  }
}

const output = await new AmlRuntime({
  agentProvider: new WorkspaceAgent(),
}).evaluate(
  <Workspace id="review-42" provider={workspaceProvider}>
    <Sandbox access="read-write" provider={sandboxProvider}>
      <Agent>write</Agent>
    </Sandbox>
    <Sandbox access="read-only" provider={sandboxProvider}>
      <Agent>observed</Agent>
    </Sandbox>
  </Workspace>,
)

if (output !== "wroteobserved:shared finding") {
  throw new Error(`Unexpected Workspace output: ${output}`)
}

console.log(output)
