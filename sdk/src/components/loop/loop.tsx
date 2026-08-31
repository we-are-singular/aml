import type { StandardSchemaV1 } from "@standard-schema/spec"

import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"

/**
 * Constrains canonical Loop state to the JSON-object shape the patch Tool owns.
 */
type ObjectStateSchema = StandardSchemaV1<unknown, Record<string, unknown>>

/**
 * Requires canonical output to remain valid input for repeated validation.
 */
type SelfNormalizingSchema<Schema extends ObjectStateSchema> =
  StandardSchemaV1.InferOutput<Schema> extends StandardSchemaV1.InferInput<Schema> ? Schema : never

/**
 * Recursively marks arrays and object properties read-only for a Loop snapshot.
 *
 * Functions retain their callable type because Loop state itself must remain
 * stable JSON and therefore cannot contain functions.
 */
export type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly unknown[]
    ? {
        readonly [Key in keyof Value]: DeepReadonly<Value[Key]>
      }
    : Value extends object
      ? {
          readonly [Key in keyof Value]: DeepReadonly<Value[Key]>
        }
      : Value

/**
 * Immutable snapshot and one-based iteration number supplied by `<Loop>`.
 */
export interface LoopRenderContext<State extends Record<string, unknown>> {
  /** One-based iteration number. The first call to `render` receives `1`. */
  readonly iteration: number

  /** Deeply frozen, schema-normalized state committed before this iteration. */
  readonly state: DeepReadonly<State>
}

/**
 * Schema, authored input, and Agent-rendering callback for one staged Loop.
 *
 * Standard Schema input and output are intentionally distinct: defaults and
 * stable transformations may normalize authored input before the first render.
 * Output must remain valid input because every staged snapshot is revalidated.
 */
export interface LoopProps<Schema extends ObjectStateSchema> {
  /**
   * Authored state validated and normalized before the first iteration.
   *
   * It must resolve through `schema` to a stable JSON object. Its normalized
   * output becomes the first immutable render snapshot.
   */
  readonly initial: StandardSchemaV1.InferInput<Schema>

  /**
   * Non-empty normalized label used in the state Tool and diagnostics.
   *
   * Defaults to `"Loop"`.
   */
  readonly name?: string

  /**
   * Produces exactly one outer `Agent` for each immutable state snapshot.
   *
   * Function components and Context providers may transparently wrap the Agent.
   * The iteration repeats only when that Agent stages a changed state.
   */
  readonly render: (context: LoopRenderContext<StandardSchemaV1.InferOutput<Schema>>) => AmlRenderable

  /**
   * Standard Schema that validates every initial, staged, and repeated snapshot.
   *
   * Its output must be a stable JSON object that remains valid as the schema's
   * input, allowing AML to revalidate each atomic state patch.
   */
  readonly schema: SelfNormalizingSchema<Schema>
}

/**
 * Repeats fresh Agent sessions over immutable transactional state snapshots.
 *
 * AmlRuntime owns this primitive because its state Tool must expire at the
 * Agent-session boundary and commits must occur only after that session ends.
 * The last Agent output is returned when an iteration stages no state change.
 *
 * @experimental Loop is exported for evaluation and is not yet a stable API.
 */
export function Loop<Schema extends ObjectStateSchema>(_props: LoopProps<Schema>): never {
  throw new Error("<Loop> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Loop, "loop")
