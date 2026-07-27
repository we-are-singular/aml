import { ComponentEvaluationContext } from "../../core/component-evaluation-context.js"
import type { AmlContext } from "./aml-context.js"
import { ContextRegistry } from "./context-registry.js"

/**
 * Reads the nearest binding for a Context during one component invocation.
 *
 * This is an ambient dependency lookup, not a reactive hook: it has no setter,
 * subscription, invalidation, or rerender behavior.
 */
export function useContext<Value>(
  context: AmlContext<Value>,
): Value {
  return ComponentEvaluationContext.readContext<Value>(
    ContextRegistry.fromContext(context),
  )
}
