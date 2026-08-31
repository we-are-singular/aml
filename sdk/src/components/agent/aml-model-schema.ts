import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"

/**
 * Structured model-output schema accepted by component-local `evaluate()`.
 *
 * Standard Schema owns validation and output inference. Standard JSON Schema
 * supplies the portable model-facing declaration from the same source. The
 * schema is forwarded to the selected Agent as its structured-output contract,
 * then AML validates the provider result and returns the Standard Schema output
 * type. A schema implementing only one of these standards is not sufficient.
 *
 * @typeParam Input Value accepted by the schema before validation or transformation.
 * @typeParam Output Value returned after successful validation or transformation.
 */
export type AmlModelSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output> &
  StandardJSONSchemaV1<Input, Output>
