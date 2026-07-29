import type { SandboxSession } from "../sandbox/sandbox-provider.js"
import type { AgentExecutionContext } from "./agent-execution-context.js"
import type { AgentProvider } from "./agent-provider.js"
import type { AgentProviderSession } from "./agent-provider-session.js"
import type { AgentRequest } from "./agent-request.js"
import type { AgentResponse } from "./agent-response.js"
import { createAgentProviderTurns } from "./create-agent-provider-turns.js"
import { executeAgentProviderSession } from "./execute-agent-provider-session.js"

/**
 * Template implementation for one fresh provider session per AML Agent.
 *
 * Subclasses own vendor configuration, capability mapping, and session
 * construction. This base owns authored turn order, cancellation, final
 * response selection, and failure-safe invocation cleanup.
 */
export abstract class AbstractAgentProvider<Name extends string> implements AgentProvider {
  readonly name: Name

  protected constructor(name: Name) {
    this.name = name
  }

  /**
   * Fails closed until a concrete adapter explicitly claims compatibility.
   */
  supportsSandbox(_sandbox: SandboxSession): boolean {
    return false
  }

  /**
   * Opens and executes one invocation-scoped provider session.
   */
  async run(request: AgentRequest, context: AgentExecutionContext): Promise<AgentResponse> {
    const turns = createAgentProviderTurns(request, this.name)
    context.signal.throwIfAborted()
    const session = await this.openSession(request, context)
    return await executeAgentProviderSession(session, turns, context, this.name)
  }

  /**
   * Attaches session-wide capabilities and creates one fresh conversation.
   */
  protected abstract openSession(request: AgentRequest, context: AgentExecutionContext): Promise<AgentProviderSession>
}
