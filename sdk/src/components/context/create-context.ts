import type { AmlContext } from "./aml-context.js"
import { ContextRegistry } from "./context-registry.js"

/**
 * Defines one required immutable downward-scoped dependency.
 *
 * Reading the returned Context without a matching Provider during an active
 * component invocation throws an EvaluationError. `name` is diagnostic and
 * must be a non-empty, already-trimmed string; Context identity is based on the
 * returned object, not that name.
 *
 * @param name Human-readable Context name used in validation errors.
 */
export function createContext<Value>(name: string): AmlContext<Value>

/**
 * Defines one downward-scoped dependency with an explicit fallback.
 *
 * The overload intentionally accepts `undefined`: supplying a second argument
 * is distinct from omitting it and therefore still defines a default.
 * The nearest Provider still takes precedence over this fallback.
 *
 * @param name Human-readable Context name used in validation errors.
 * @param defaultValue Value returned when no Provider exists in the active scope.
 */
export function createContext<Value>(name: string, defaultValue: Value): AmlContext<Value>

/**
 * Captures Context identity without reading application data or running AML.
 *
 * Call this once at module scope and share the returned definition with its
 * Provider and every `useContext()` consumer.
 */
export function createContext<Value>(name: string, ...defaultValue: [] | [Value]): AmlContext<Value> {
  if (typeof name !== "string" || name.length === 0 || name !== name.trim()) {
    throw new TypeError("Context name must be a non-empty normalized string")
  }

  return ContextRegistry.create(name, defaultValue.length === 1, defaultValue[0])
}
