import type { AmlEventSubscriber } from "../../core/aml-event-subscriber.js"
import type { AmlTraceIdentity } from "../../core/trace-identity.js"
import type { SandboxSession } from "../sandbox/sandbox-provider.js"

/**
 * Evaluation-scoped dependencies supplied to one provider session.
 */
export interface AgentExecutionContext {
  /** Evaluation event subscription boundary shared with the provider session. */
  readonly events: AmlEventSubscriber

  /**
   * Effective Sandbox session for model-controlled execution, when present.
   *
   * Providers must return `true` from `supportsSandbox` before AML supplies a
   * Sandbox context to `run`.
   */
  readonly sandbox?: SandboxSession

  /**
   * Invocation signal aborted by caller cancellation or an Agent timeout.
   *
   * Providers must stop pending work cooperatively and must not replace the
   * signal's reason with a provider-native cancellation error.
   */
  readonly signal: AbortSignal

  /** Trace identity of the enclosing AML Agent boundary. */
  readonly trace: AmlTraceIdentity
}
