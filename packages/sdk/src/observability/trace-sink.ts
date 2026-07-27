import type { AmlTraceEvent } from "./trace-event.js"

/**
 * Receives immutable execution events without participating in workflow flow.
 *
 * A sink must return synchronously. Setting `captureContent` opts this consumer
 * into sensitive text fields owned by the portable AML runtime.
 */
export interface TraceSink {
  (event: AmlTraceEvent): void
  readonly captureContent?: boolean
}

/**
 * Receives a trace-consumer failure through an isolated secondary channel.
 */
export type TraceErrorHandler = (
  error: unknown,
  event: AmlTraceEvent,
) => void
