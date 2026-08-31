/**
 * Reports invalid authored AML values and evaluator invariants.
 *
 * Use `instanceof EvaluationError` to distinguish structural workflow errors,
 * such as misplaced primitives, exceeded evaluation limits, cycles, or invalid
 * component composition, from provider and application failures passed through
 * by the runtime.
 */
export class EvaluationError extends Error {
  /** Stable error name for logs and error-boundary classification. */
  override readonly name = "EvaluationError"
}
