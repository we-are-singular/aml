/**
 * Correlates one provider session with its containing AML evaluation.
 *
 * Identity values are opaque to providers. Their format may change without
 * changing the provider contract.
 */
export interface AmlTraceIdentity {
  readonly parentSpanId?: string
  readonly runId: string
  readonly spanId: string
}
