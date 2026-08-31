import type { StandardSchemaV1 } from "@standard-schema/spec"

import type { AmlModelSchema } from "../components/agent/aml-model-schema.js"
import type { AmlRenderable } from "./aml-node.js"
import { ComponentEvaluationContext } from "./component-evaluation-context.js"

/**
 * Evaluates AML as data inside the currently active function component.
 *
 * This is an ordinary asynchronous call. It never suspends or rerenders the
 * component, and detached calls reject after AML observes its completion. The
 * subtree inherits the current Context, Workspace, Sandbox, cancellation,
 * limits, and trace parent.
 *
 * With no schema, the promise resolves to rendered text. With an
 * {@link AmlModelSchema}, the subtree must resolve to exactly one outer Agent
 * and the promise resolves to that schema's validated output. Calling this
 * function outside an actively evaluated component throws.
 *
 * @param value AML subtree to evaluate within the current component scope.
 * @param schema Optional Standard Schema contract for structured Agent output.
 */
export function evaluate(value: AmlRenderable): Promise<string>
/**
 * Evaluates one structured Agent subtree inside the current function component.
 *
 * The supplied Standard Schema is forwarded to the outer Agent provider and
 * validates its result. The promise resolves to the schema's inferred output
 * type rather than rendered text.
 *
 * @param value AML subtree that must resolve to exactly one outer Agent.
 * @param schema Standard Schema contract for the Agent's structured output.
 */
export function evaluate<Schema extends AmlModelSchema<unknown, unknown>>(
  value: AmlRenderable,
  schema: Schema
): Promise<StandardSchemaV1.InferOutput<Schema>>
export function evaluate(value: AmlRenderable, schema?: AmlModelSchema<unknown, unknown>): Promise<unknown> {
  return ComponentEvaluationContext.evaluate(value, schema)
}
