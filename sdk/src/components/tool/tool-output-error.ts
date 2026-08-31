/**
 * Reports a JavaScript Tool result that cannot cross the provider boundary.
 *
 * AML throws this when output validation fails or the result cannot be captured
 * as JSON-compatible data. Application exceptions thrown by the Tool callback
 * itself are not relabeled as this error. Validation detail is retained as
 * `cause` where available.
 */
export class ToolOutputError extends Error {
  /**
   * Stable error identity for transport and trace classification.
   */
  override readonly name = "ToolOutputError"
}
