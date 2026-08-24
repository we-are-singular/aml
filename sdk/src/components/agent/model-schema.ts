import type { AmlJsonValue } from "../../core/aml-json-value.js"
import { JsonSnapshot } from "../tool/json-snapshot.js"
import { type SchemaValidation, StandardSchemaAdapter } from "../tool/standard-schema-adapter.js"
import type { AmlModelSchema } from "./aml-model-schema.js"

/**
 * Captures one model-output contract before any Agent provider executes.
 *
 * The application-owned schema never crosses the provider boundary. This
 * owner converts it once into immutable JSON Schema and retains the original
 * validator only for the final structured response.
 */
export class ModelSchema<Output> {
  readonly #adapter: StandardSchemaAdapter
  readonly jsonSchema: Readonly<Record<string, AmlJsonValue>>

  /**
   * Validates the dual Standard Schema contract and snapshots its JSON Schema.
   */
  constructor(schema: AmlModelSchema<unknown, Output>) {
    this.#adapter = new StandardSchemaAdapter(schema, true, "Agent output schema")

    let captured: AmlJsonValue

    try {
      captured = JsonSnapshot.capture(this.#adapter.inputJsonSchema(), "Agent output JSON Schema")
    } catch (cause) {
      throw new TypeError("Agent output JSON Schema is invalid", {
        cause,
      })
    }

    if (typeof captured !== "object" || captured === null || Array.isArray(captured)) {
      throw new TypeError("Agent output JSON Schema must be an object")
    }

    this.jsonSchema = captured as Readonly<Record<string, AmlJsonValue>>
    Object.freeze(this)
  }

  /**
   * Validates and returns the schema's inferred, potentially transformed value.
   */
  async validate(value: unknown): Promise<Output> {
    let captured: AmlJsonValue

    try {
      // Providers are untrusted transport boundaries. Standard Schema may be
      // intentionally permissive, but model output must still be portable JSON
      // before application validation or transformations can observe it.
      captured = JsonSnapshot.capture(value, "Agent structured output")
    } catch (cause) {
      throw new TypeError("Agent structured output is not valid JSON", {
        cause,
      })
    }

    const result: SchemaValidation = await this.#adapter.validate(captured)

    if (!result.success) {
      throw new TypeError("Agent structured output failed schema validation", { cause: result.issues })
    }

    return result.value as Output
  }

  /**
   * Renders a transformed schema result as canonical JSON for AML text channels.
   */
  stringify(value: unknown): string {
    let captured: AmlJsonValue

    try {
      captured = JsonSnapshot.capture(value, "Transformed Agent structured output")
    } catch (cause) {
      throw new TypeError("Transformed Agent structured output cannot be rendered as JSON text", { cause })
    }

    return JSON.stringify(captured)
  }
}
