import { ComponentEvaluationContext } from "../core/component-evaluation-context.js"

/**
 * Measures application-owned work beneath the currently active AML component.
 * The callback result and thrown value pass through unchanged.
 */
export function withTraceSpan<Result>(name: string, operation: () => PromiseLike<Result> | Result): Promise<Result> {
  if (typeof name !== "string" || name.length === 0 || name.trim() !== name) {
    throw new TypeError("withTraceSpan name must be a non-empty normalized string")
  }

  if (typeof operation !== "function") {
    throw new TypeError("withTraceSpan operation must be a function")
  }

  return ComponentEvaluationContext.runApplicationSpan(name, operation)
}
