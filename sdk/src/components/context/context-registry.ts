import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"
import { EvaluationError } from "../../core/evaluation-error.js"
import type { AmlContext, ContextProviderProps } from "./aml-context.js"

const AML_CONTEXT_REGISTRY = Symbol.for("@aml-jsx/sdk/context-registry")

/**
 * Runtime metadata shared by a Context handle and its Provider component.
 */
export interface RegisteredContext {
  readonly context: object
  readonly defaultValue: unknown
  readonly hasDefault: boolean
  readonly name: string
  readonly provider: Function
}

/**
 * Context Provider data captured once before either evaluator enters its scope.
 */
interface ContextProviderBinding {
  readonly children: AmlRenderable
  readonly definition: RegisteredContext
  readonly value: unknown
}

interface ContextRegistryStorage {
  readonly contexts: WeakMap<object, RegisteredContext>
  readonly providers: WeakMap<Function, RegisteredContext>
}

interface AmlContextGlobal {
  [AML_CONTEXT_REGISTRY]?: ContextRegistryStorage
}

/**
 * Owns exact-identity Context registration across physical SDK copies.
 *
 * A realm-wide pair of WeakMaps keeps internal metadata off the public Context
 * object and prevents a structurally similar application object from becoming
 * an ambient dependency capability.
 */
export class ContextRegistry {
  static readonly #storage = contextRegistryStorage()

  /**
   * Creates one frozen public Context and registers its runtime-only metadata.
   */
  static create<Value>(name: string, hasDefault: boolean, defaultValue: Value | undefined): AmlContext<Value> {
    /**
     * The runtime recognizes this function by exact registration and evaluates
     * its children inside a new lexical binding. Direct invocation is invalid.
     */
    function Provider(_props: ContextProviderProps<Value>): never {
      throw new Error(`<${name}.Provider> can only be evaluated by AmlRuntime`)
    }

    AmlNode.markPrimitive(Provider, "context")

    const context: AmlContext<Value> = Object.freeze({
      name,
      Provider,
    })
    const definition: RegisteredContext = Object.freeze({
      context,
      defaultValue,
      hasDefault,
      name,
      provider: Provider,
    })

    ContextRegistry.#storage.contexts.set(context, definition)
    ContextRegistry.#storage.providers.set(Provider, definition)

    return context
  }

  /**
   * Resolves a public Context handle or rejects an unregistered lookalike.
   */
  static fromContext<Value>(context: AmlContext<Value>): RegisteredContext {
    if ((typeof context !== "object" || context === null) && typeof context !== "function") {
      throw new TypeError("useContext() requires a Context returned by createContext()")
    }

    const definition = ContextRegistry.#storage.contexts.get(context as object)

    if (definition === undefined) {
      throw new TypeError("useContext() requires a Context returned by createContext()")
    }

    return definition
  }

  /**
   * Returns metadata for an exact registered Provider component.
   */
  static fromProvider(provider: Function): RegisteredContext | undefined {
    return ContextRegistry.#storage.providers.get(provider)
  }

  /**
   * Validates and captures one registered Provider occurrence exactly once.
   *
   * Both the main evaluator and Loop outer-Agent selector use this boundary so
   * Context placement cannot drift into subtly different runtime semantics.
   */
  static captureProvider(provider: Function, props: Readonly<Record<string, unknown>>): ContextProviderBinding {
    const definition = ContextRegistry.fromProvider(provider)

    if (definition === undefined) {
      throw new EvaluationError("AML encountered an unregistered Context Provider")
    }

    if (!Object.hasOwn(props, "value")) {
      throw new EvaluationError(`<${definition.name}.Provider> requires a value prop`)
    }

    // Preserve authored prop order across both evaluators. A cross-copy node
    // may expose stateful accessors, so each field is read exactly once and the
    // provided dependency must be captured before descendant work is selected.
    const value = Reflect.get(props, "value")
    const children = Reflect.get(props, "children") as AmlRenderable

    return Object.freeze({
      children,
      definition,
      value,
    })
  }
}

/**
 * Shares Context identity across compatible SDK copies in one realm.
 */
function contextRegistryStorage(): ContextRegistryStorage {
  const amlGlobal = globalThis as typeof globalThis & AmlContextGlobal
  const existing = amlGlobal[AML_CONTEXT_REGISTRY]

  if (existing !== undefined) {
    if (
      typeof existing !== "object" ||
      existing === null ||
      !(existing.contexts instanceof WeakMap) ||
      !(existing.providers instanceof WeakMap)
    ) {
      throw new TypeError("AML Context registry has an invalid global value")
    }

    return existing
  }

  const created: ContextRegistryStorage = Object.freeze({
    contexts: new WeakMap(),
    providers: new WeakMap(),
  })

  Object.defineProperty(amlGlobal, AML_CONTEXT_REGISTRY, {
    configurable: false,
    enumerable: false,
    value: created,
    writable: false,
  })

  return created
}
