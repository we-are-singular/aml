import { ComponentEvaluationContext } from "../core/component-evaluation-context.js"

/**
 * Measures application-owned work beneath the currently active AML component.
 *
 * AML allocates an `application` span beneath the active component or enclosing
 * application span and closes it on success, failure, or cancellation. The
 * callback result and thrown value pass through unchanged. Nested calls remain
 * correctly parented across asynchronous and concurrent work.
 *
 * Calling this outside an active component, including from work detached after
 * component settlement, throws an EvaluationError. `name` must be a non-empty,
 * already-trimmed string.
 *
 * @param name Caller-owned span name used for traces and summary aggregation.
 * @param operation Synchronous or asynchronous application work to measure.
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
