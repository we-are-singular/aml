/**
 * Reports a JavaScript Tool result that cannot cross the provider boundary.
 */
export class ToolOutputError extends Error {
  /**
   * Stable error identity for transport and trace classification.
   */
  override readonly name = "ToolOutputError"
}
