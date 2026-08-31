import type { SandboxSession } from "../sandbox/sandbox-provider.js"
import type { AgentExecutionContext } from "./agent-execution-context.js"
import type { AgentRequest } from "./agent-request.js"
import type { AgentResponse } from "./agent-response.js"

/**
 * Executes one fully assembled Agent request through a configured harness.
 */
export interface AgentProvider {
  /**
   * Non-empty normalized provider identifier used in errors and trace metadata.
   *
   * The name identifies the adapter, not a model or individual session.
   */
  readonly name: string

  /**
   * Executes one isolated provider session for the complete authored turn plan.
   *
   * The initial prompt and every request FollowUp share provider history and
   * session-wide capabilities; only the final response is returned to AML. The
   * method must honor `context.signal` and settle only after invocation-owned
   * cleanup completes.
   */
  run(request: AgentRequest, context: AgentExecutionContext): Promise<AgentResponse>

  /**
   * Confirms that model-controlled actions honor one effective Sandbox.
   *
   * A provider without this handshake cannot execute inside `<Sandbox>`. The
   * check must describe enforcement, not merely whether a process can start.
   */
  supportsSandbox?(sandbox: SandboxSession): boolean
}
