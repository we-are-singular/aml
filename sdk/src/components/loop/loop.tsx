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
 * Recursive read-only view supplied to one Loop render iteration.
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
  readonly iteration: number
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
  readonly initial: StandardSchemaV1.InferInput<Schema>
  readonly name?: string
  readonly render: (context: LoopRenderContext<StandardSchemaV1.InferOutput<Schema>>) => AmlRenderable
  readonly schema: SelfNormalizingSchema<Schema>
}

/**
 * Repeats fresh Agent sessions over immutable transactional state snapshots.
 *
 * AmlRuntime owns this primitive because its state Tool must expire at the
 * Agent-session boundary and commits must occur only after that session ends.
 */
export function Loop<Schema extends ObjectStateSchema>(_props: LoopProps<Schema>): never {
  throw new Error("<Loop> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Loop, "loop")
