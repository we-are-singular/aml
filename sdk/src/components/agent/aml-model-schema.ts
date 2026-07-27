import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec"

/**
 * Structured model-output schema accepted by component-local `evaluate()`.
 *
 * Standard Schema owns validation and output inference. Standard JSON Schema
 * supplies the portable model-facing declaration from the same source.
 */
export type AmlModelSchema<Input = unknown, Output = Input> =
  StandardSchemaV1<Input, Output> &
    StandardJSONSchemaV1<Input, Output>
