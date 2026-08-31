/**
 * Reports model-supplied Tool input rejected before application code ran.
 *
 * AML throws this when input is neither valid directly nor as JSON, when the
 * input schema itself fails, or when schema validation rejects the value. The
 * original parse or validation detail is retained as `cause` where available.
 */
export class ToolInputError extends Error {
  /**
   * Stable error identity for transport and trace classification.
   */
  override readonly name = "ToolInputError"
}
