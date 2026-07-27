/**
 * Reports model-supplied Tool input rejected before application code ran.
 */
export class ToolInputError extends Error {
  /**
   * Stable error identity for transport and trace classification.
   */
  override readonly name = "ToolInputError"
}
