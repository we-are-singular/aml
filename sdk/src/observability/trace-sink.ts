import type { AmlTraceEvent } from "./trace-event.js"

/**
 * Receives immutable execution events without participating in workflow flow.
 *
 * AML never awaits a returned Promise. Setting `captureContent` opts only this
 * consumer into sensitive text fields owned by the portable AML runtime.
 */
export interface TraceSink {
  /**
   * Observes one immutable trace event.
   *
   * AML does not await the return value. Synchronous throws and rejected
   * thenables are routed to `AmlRuntimeOptions.onTraceError` without changing
   * evaluation success.
   */
  (event: AmlTraceEvent): unknown

  /**
   * Whether this sink receives sensitive content fields in trace attributes.
   *
   * Defaults to `false` when omitted. AML captures this flag when the listener
   * is registered; changing it later does not change that registration.
   */
  readonly captureContent?: boolean
}

/**
 * Receives a trace-consumer failure through an isolated secondary channel.
 *
 * @param error Value thrown or rejected by a trace listener.
 * @param event Redacted event being delivered when the listener failed.
 */
export type TraceErrorHandler = (error: unknown, event: AmlTraceEvent) => void
