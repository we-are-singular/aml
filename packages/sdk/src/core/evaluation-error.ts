/**
 * Reports invalid authored AML values and evaluator invariants.
 */
export class EvaluationError extends Error {
  override readonly name = "EvaluationError"
}
