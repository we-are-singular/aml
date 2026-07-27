import type { StandardSchemaV1 } from "@standard-schema/spec"

import type { AmlModelSchema } from "../components/agent/aml-model-schema.js"
import type { AmlRenderable } from "./aml-node.js"
import { ComponentEvaluationContext } from "./component-evaluation-context.js"

/**
 * Evaluates AML as data inside the currently active function component.
 *
 * This is an ordinary asynchronous call. It never suspends or rerenders the
 * component, and detached calls reject after AML observes its completion.
 */
export function evaluate(value: AmlRenderable): Promise<string>
export function evaluate<
  Schema extends AmlModelSchema<unknown, unknown>,
>(
  value: AmlRenderable,
  schema: Schema,
): Promise<StandardSchemaV1.InferOutput<Schema>>
export function evaluate(
  value: AmlRenderable,
  schema?: AmlModelSchema<unknown, unknown>,
): Promise<unknown> {
  return ComponentEvaluationContext.evaluate(value, schema)
}
