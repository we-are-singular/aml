import type { SandboxSession } from "../sandbox/sandbox-provider.js"
import type { AgentExecutionContext } from "./agent-execution-context.js"
import type { AgentProvider } from "./agent-provider.js"
import type { AgentProviderSession } from "./agent-provider-session.js"
import type { AgentRequest } from "./agent-request.js"
import type { AgentResponse } from "./agent-response.js"
import { agentObservabilityServices } from "./agent-observability-services.js"
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
  /** Stable non-empty normalized identifier used in diagnostics and traces. */
  readonly name: Name

  /**
   * Creates a provider base with a literal name retained in the subclass type.
   *
   * Concrete subclasses should expose their own application-facing factory and
   * implement `openSession` for exactly one AML Agent invocation.
   */
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
    const observability = agentObservabilityServices(context)

    // The session span starts before openSession() and closes only after the
    // executor has run provider cleanup, so setup and teardown failures remain
    // inside the same real lifecycle boundary.
    const sessionTrace = observability.createTrace(context.trace.spanId)
    const sessionSpan = observability.startSpan(sessionTrace, "agent.session", {
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.name === undefined ? {} : { name: request.name }),
      provider: this.name,
    })
    // Session setup can emit process and ACP creation events before turn one.
    observability.setCurrentTrace(sessionTrace)

    try {
      const session = await this.openSession(request, context)
      const response = await executeAgentProviderSession(session, turns, context, this.name)
      observability.endSpan(sessionSpan, "ok")
      return response
    } catch (error) {
      observability.failSpan(sessionSpan, error)
      throw error
    } finally {
      observability.setCurrentTrace(context.trace)
    }
  }

  /**
   * Attaches session-wide capabilities and creates one fresh conversation.
   *
   * The returned session is consumed exactly once. `AbstractAgentProvider`
   * guarantees ordered turns, cancellation notification, and `close()` after
   * success or failure.
   */
  protected abstract openSession(request: AgentRequest, context: AgentExecutionContext): Promise<AgentProviderSession>
}
