import type { AmlContext } from "./aml-context.js"
import { ContextRegistry } from "./context-registry.js"

/**
 * Defines one required immutable downward-scoped dependency.
 */
export function createContext<Value>(
  name: string,
): AmlContext<Value>

/**
 * Defines one downward-scoped dependency with an explicit fallback.
 *
 * The overload intentionally accepts `undefined`: supplying a second argument
 * is distinct from omitting it and therefore still defines a default.
 */
export function createContext<Value>(
  name: string,
  defaultValue: Value,
): AmlContext<Value>

/**
 * Captures Context identity without reading application data or running AML.
 */
export function createContext<Value>(
  name: string,
  ...defaultValue: [] | [Value]
): AmlContext<Value> {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name !== name.trim()
  ) {
    throw new TypeError(
      "Context name must be a non-empty normalized string",
    )
  }

  return ContextRegistry.create(
    name,
    defaultValue.length === 1,
    defaultValue[0],
  )
}
