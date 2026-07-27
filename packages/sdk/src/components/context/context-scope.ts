import type { RegisteredContext } from "./context-registry.js"

/**
 * Result shape that preserves an explicitly provided `undefined` value.
 */
type ContextLookup =
  | Readonly<{ readonly found: false }>
  | Readonly<{
      readonly found: true
      readonly value: unknown
    }>

const MISSING_CONTEXT: ContextLookup = Object.freeze({
  found: false,
})

/**
 * Persistent linked map for one lexical Context branch.
 *
 * Providing a value allocates a child scope instead of mutating its parent.
 * Concurrent component-local evaluations can therefore share an inherited
 * scope safely while independently shadowing it.
 */
export class ContextScope {
  static readonly empty = new ContextScope()

  readonly #definition: RegisteredContext | undefined
  readonly #parent: ContextScope | undefined
  readonly #value: unknown

  private constructor(
    parent?: ContextScope,
    definition?: RegisteredContext,
    value?: unknown,
  ) {
    this.#definition = definition
    this.#parent = parent
    this.#value = value
    Object.freeze(this)
  }

  /**
   * Returns a new lexical scope with one exact Context identity shadowed.
   */
  provide(
    definition: RegisteredContext,
    value: unknown,
  ): ContextScope {
    return new ContextScope(this, definition, value)
  }

  /**
   * Reads the nearest matching binding without consulting Context defaults.
   */
  lookup(definition: RegisteredContext): ContextLookup {
    let scope: ContextScope | undefined = this

    while (scope !== undefined) {
      if (scope.#definition === definition) {
        return Object.freeze({
          found: true,
          value: scope.#value,
        })
      }

      scope = scope.#parent
    }

    return MISSING_CONTEXT
  }
}
