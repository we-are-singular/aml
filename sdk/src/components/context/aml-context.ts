import type {
  AmlComponent,
  AmlRenderable,
} from "../../core/aml-node.js"

/**
 * Props accepted by the lexical Provider owned by one AML Context.
 */
export interface ContextProviderProps<Value> {
  readonly children?: AmlRenderable
  readonly value: Value
}

/**
 * Typed identity for one immutable downward-scoped dependency.
 *
 * Context identity is the returned object, not `name`. The name exists only
 * for diagnostics, so separately created contexts never alias accidentally.
 */
export interface AmlContext<Value> {
  readonly name: string
  readonly Provider: AmlComponent<ContextProviderProps<Value>>
}
