import { ComponentEvaluationContext } from "../../core/component-evaluation-context.js"
import type { AmlContext } from "./aml-context.js"
import { ContextRegistry } from "./context-registry.js"

/**
 * Reads the nearest binding for a Context during one component invocation.
 *
 * This is an ambient dependency lookup, not a reactive hook: it has no setter,
 * subscription, invalidation, or rerender behavior.
 *
 * The nearest matching Provider wins; otherwise the Context's explicit default
 * is returned. Calling outside an active AML function component, after that
 * component has settled, with an invalid Context object, or without a binding
 * or default throws an EvaluationError.
 *
 * @param context Exact Context definition previously returned by `createContext()`.
 */
export function useContext<Value>(context: AmlContext<Value>): Value {
  return ComponentEvaluationContext.readContext<Value>(ContextRegistry.fromContext(context))
}
