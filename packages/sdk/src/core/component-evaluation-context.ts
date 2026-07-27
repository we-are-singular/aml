import { AsyncLocalStorage } from "node:async_hooks"

import type { AmlModelSchema } from "../components/agent/aml-model-schema.js"
import type { RegisteredContext } from "../components/context/context-registry.js"
import { ContextScope } from "../components/context/context-scope.js"
import type { AmlRenderable } from "./aml-node.js"
import { EvaluationError } from "./evaluation-error.js"

type NestedEvaluator = (
  value: AmlRenderable,
  schema: AmlModelSchema<unknown, unknown> | undefined,
) => Promise<unknown>

interface ComponentEvaluationBinding {
  active: boolean
  contextScope: ContextScope | undefined
  evaluate: NestedEvaluator | undefined
  readonly pending: Set<Promise<unknown>>
}

const AML_COMPONENT_EVALUATION_STORAGE = Symbol.for(
  "@aml/sdk/component-evaluation-storage",
)

interface AmlEvaluationGlobal {
  [AML_COMPONENT_EVALUATION_STORAGE]?: AsyncLocalStorage<ComponentEvaluationBinding>
}

/**
 * Propagates component-local evaluation and Context access through awaited work.
 *
 * AsyncLocalStorage preserves the binding across `await`, while the explicit
 * active flag closes the capability as soon as the component settles. The flag
 * is essential because detached timers inherit async-local context even after
 * their originating component has returned.
 */
export class ComponentEvaluationContext {
  static readonly #storage =
    componentEvaluationStorage()

  /**
   * Evaluates a nested AML tree through the currently active component.
   */
  static evaluate(
    value: AmlRenderable,
    schema?: AmlModelSchema<unknown, unknown>,
  ): Promise<unknown> {
    const binding = ComponentEvaluationContext.#storage.getStore()

    const evaluateNested = binding?.evaluate

    if (
      binding === undefined ||
      !binding.active ||
      evaluateNested === undefined
    ) {
      throw new EvaluationError(
        "evaluate() is only available while an AML component is active",
      )
    }

    const pending = evaluateNested(value, schema)
    binding.pending.add(pending)

    // Track only work still active when the component settles. Both handlers
    // observe rejection immediately without changing the Promise returned to
    // the component or manufacturing another unhandled Promise.
    void pending.then(
      () => binding.pending.delete(pending),
      () => binding.pending.delete(pending),
    )

    return pending
  }

  /**
   * Reads one Context through the currently active component binding.
   */
  static readContext<Value>(
    definition: RegisteredContext,
  ): Value {
    const binding = ComponentEvaluationContext.#storage.getStore()
    const contextScope = binding?.contextScope

    if (
      binding === undefined ||
      !binding.active ||
      contextScope === undefined
    ) {
      throw new EvaluationError(
        "useContext() is only available while an AML component is active",
      )
    }

    const lookup = contextScope.lookup(definition)

    if (lookup.found) {
      return lookup.value as Value
    }

    if (definition.hasDefault) {
      return definition.defaultValue as Value
    }

    throw new EvaluationError(
      `Context "${definition.name}" has no Provider or default value`,
    )
  }

  /**
   * Masks component-local evaluation and Context from provider callbacks.
   *
   * A provider that awaited another Agent while retaining its current scheduler
   * slot could deadlock the domain. Agent-as-Tool is intentionally not part of
   * the current execution model, so this boundary fails closed.
   */
  static withoutAccess<Result>(operation: () => Result): Result {
    return ComponentEvaluationContext.#storage.exit(operation)
  }

  /**
   * Invokes one component exactly once with a scoped nested evaluator.
   */
  static async invoke(
    component: () => unknown,
    evaluateNested: NestedEvaluator,
    contextScope: ContextScope,
  ): Promise<unknown> {
    const binding: ComponentEvaluationBinding = {
      active: true,
      contextScope,
      evaluate: evaluateNested,
      pending: new Set(),
    }
    let componentError: unknown
    let componentFailed = false
    let output: unknown

    try {
      const result = ComponentEvaluationContext.#storage.run(
        binding,
        component,
      )
      let then: unknown

      if (
        (typeof result === "object" && result !== null) ||
        typeof result === "function"
      ) {
        // Read a possible thenable exactly once. Synchronous components revoke
        // their capability before queued microtasks run; async components keep
        // it until the returned thenable actually settles.
        then = ComponentEvaluationContext.#storage.run(
          binding,
          () => Reflect.get(result, "then"),
        )
      }

      if (typeof then === "function") {
        output = await new Promise<unknown>((resolve, reject) => {
          queueMicrotask(() => {
            // Custom thenables start their returned completion chain only when
            // `then` runs, so re-enter the binding that native async functions
            // already propagate through their Promise jobs.
            ComponentEvaluationContext.#storage.run(binding, () => {
              try {
                Reflect.apply(then, result, [resolve, reject])
              } catch (error) {
                reject(error)
              }
            })
          })
        })
      } else {
        output = result
      }
    } catch (error) {
      componentFailed = true
      componentError = error
    } finally {
      // Detached work still carries the object through AsyncLocalStorage, so
      // revocation must mutate the shared binding rather than merely exit run().
      // Dropping the closure also prevents a detached timer from retaining the
      // complete runtime and evaluation domain after access has been revoked.
      binding.active = false
      binding.contextScope = undefined
      binding.evaluate = undefined
    }

    // Promise.all() rejects before its remaining branches settle. Join only the
    // still-active nested evaluations before an enclosing resource scope can
    // release underneath them.
    const pendingResults = await Promise.allSettled([...binding.pending])
    binding.pending.clear()
    const pendingErrors = pendingResults
      .filter(
        (
          result,
        ): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason as unknown)

    if (componentFailed) {
      const additionalErrors = pendingErrors.filter(
        (error) => error !== componentError,
      )

      if (additionalErrors.length > 0) {
        throw new AggregateError(
          [componentError, ...additionalErrors],
          "AML component and concurrent nested evaluations failed",
        )
      }

      throw componentError
    }

    if (pendingErrors.length === 1) {
      throw pendingErrors[0]
    }

    if (pendingErrors.length > 1) {
      throw new AggregateError(
        pendingErrors,
        "AML component nested evaluations failed",
      )
    }

    return output
  }
}

/**
 * Shares the active component scope across physical SDK copies in one realm.
 */
function componentEvaluationStorage(): AsyncLocalStorage<ComponentEvaluationBinding> {
  const amlGlobal = globalThis as typeof globalThis & AmlEvaluationGlobal
  const existing = amlGlobal[AML_COMPONENT_EVALUATION_STORAGE]

  if (existing !== undefined) {
    if (!(existing instanceof AsyncLocalStorage)) {
      throw new TypeError(
        "AML component evaluation storage has an invalid global value",
      )
    }

    return existing
  }

  const created =
    new AsyncLocalStorage<ComponentEvaluationBinding>()

  Object.defineProperty(amlGlobal, AML_COMPONENT_EVALUATION_STORAGE, {
    configurable: false,
    enumerable: false,
    value: created,
    writable: false,
  })

  return created
}
