import type { AmlComponent, AmlRenderable } from "../../core/aml-node.js"

/**
 * Props accepted by the lexical Provider owned by one AML Context.
 */
export interface ContextProviderProps<Value> {
  /**
   * Descendant AML values evaluated with this lexical binding.
   *
   * Omission creates an empty binding scope.
   */
  readonly children?: AmlRenderable

  /**
   * Value reference returned by `useContext` to descendants.
   *
   * The prop itself is required even when `Value` intentionally includes
   * `undefined`. AML captures the reference before descendant evaluation but
   * does not clone or freeze the supplied value; mutable objects remain shared.
   */
  readonly value: Value
}

/**
 * Typed identity for one downward-scoped dependency binding.
 *
 * Context identity is the returned object, not `name`. The name exists only
 * for diagnostics, so separately created contexts never alias accidentally.
 */
export interface AmlContext<Value> {
  /**
   * Non-empty normalized diagnostic name supplied to `createContext`.
   *
   * The name does not determine identity and separately created Contexts with
   * the same name never share values.
   */
  readonly name: string

  /**
   * Lexical AML component that binds a required `value` for its descendants.
   *
   * Nested Providers shadow outer bindings only for their own subtree. Direct
   * invocation is invalid; use it as JSX evaluated by `AmlRuntime`.
   */
  readonly Provider: AmlComponent<ContextProviderProps<Value>>
}
