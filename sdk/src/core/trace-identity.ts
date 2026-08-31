/**
 * Correlates one provider session with its containing AML evaluation.
 *
 * Identity values are opaque to providers. Their format may change without
 * changing the provider contract.
 */
export interface AmlTraceIdentity {
  /** Span that contains this provider session; omitted only for a root span. */
  readonly parentSpanId?: string

  /** Opaque identifier shared by every trace event in one AML evaluation. */
  readonly runId: string

  /** Opaque identifier of the Agent span associated with this provider session. */
  readonly spanId: string
}
