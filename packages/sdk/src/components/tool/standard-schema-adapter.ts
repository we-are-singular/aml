import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec"

interface SchemaSuccess {
  readonly success: true
  readonly value: unknown
}

interface SchemaFailure {
  readonly issues: readonly StandardSchemaV1.Issue[]
  readonly success: false
}

/**
 * AML-owned normalization of Standard Schema's success/failure union.
 */
export type SchemaValidation = SchemaFailure | SchemaSuccess

/**
 * Captures and validates the callable Standard Schema boundary once.
 *
 * The adapter keeps third-party schema objects outside the rest of the runtime
 * and converts their structural result union into one AML-owned result type.
 */
export class StandardSchemaAdapter {
  readonly #jsonInput:
    | StandardJSONSchemaV1.Converter["input"]
    | undefined
  readonly #jsonSchemaReceiver: object | undefined
  readonly #label: string
  readonly #standardReceiver: object
  readonly #validate: StandardSchemaV1.Props["validate"]

  /**
   * Captures validation and optional JSON Schema conversion methods.
   *
   * Input schemas require JSON Schema because providers must advertise them;
   * output-only schemas need validation but are never sent to a model.
   */
  constructor(
    schema: StandardSchemaV1,
    requireJsonSchema: boolean,
    label = "Tool schema",
  ) {
    this.#label = label

    if (typeof schema !== "object" || schema === null) {
      throw new TypeError(`${this.#label} must be an object`)
    }

    const standard = Reflect.get(schema, "~standard")

    if (typeof standard !== "object" || standard === null) {
      throw new TypeError(
        `${this.#label} must implement Standard Schema`,
      )
    }

    const version = Reflect.get(standard, "version")
    const vendor = Reflect.get(standard, "vendor")
    const validate = Reflect.get(standard, "validate")

    if (
      version !== 1 ||
      typeof vendor !== "string" ||
      vendor.length === 0 ||
      typeof validate !== "function"
    ) {
      throw new TypeError(
        `${this.#label} has an invalid Standard Schema contract`,
      )
    }

    this.#standardReceiver = standard
    this.#validate = validate as StandardSchemaV1.Props["validate"]

    // Output schemas deliberately stop at the validation boundary.
    if (!requireJsonSchema) {
      this.#jsonInput = undefined
      this.#jsonSchemaReceiver = undefined
      return
    }

    const jsonSchema = Reflect.get(standard, "jsonSchema")
    const jsonInput =
      typeof jsonSchema === "object" && jsonSchema !== null
        ? Reflect.get(jsonSchema, "input")
        : undefined

    if (typeof jsonInput !== "function") {
      throw new TypeError(
        `${this.#label} must implement Standard JSON Schema`,
      )
    }

    this.#jsonInput =
      jsonInput as StandardJSONSchemaV1.Converter["input"]
    this.#jsonSchemaReceiver = jsonSchema
  }

  /**
   * Generates the provider-facing draft 2020-12 input schema.
   */
  inputJsonSchema(): Record<string, unknown> {
    if (!this.#jsonInput || !this.#jsonSchemaReceiver) {
      throw new TypeError(
        `${this.#label} has no input JSON Schema converter`,
      )
    }

    return Reflect.apply(this.#jsonInput, this.#jsonSchemaReceiver, [
      { target: "draft-2020-12" },
    ]) as Record<string, unknown>
  }

  /**
   * Validates one unknown value and rejects malformed schema implementations.
   */
  async validate(value: unknown): Promise<SchemaValidation> {
    const rawResult: unknown = await Reflect.apply(
      this.#validate,
      this.#standardReceiver,
      [value],
    )

    if (
      typeof rawResult !== "object" ||
      rawResult === null ||
      Array.isArray(rawResult)
    ) {
      throw new TypeError(
        `${this.#label} returned an invalid Standard Schema result`,
      )
    }

    // Standard Schema uses the presence of issues to distinguish failure.
    const issues = Reflect.get(rawResult, "issues")

    if (issues !== undefined) {
      if (
        !Array.isArray(issues) ||
        issues.some(
          (issue) =>
            typeof issue !== "object" ||
            issue === null ||
            typeof Reflect.get(issue, "message") !== "string",
        )
      ) {
        throw new TypeError(
          `${this.#label} returned invalid Standard Schema issues`,
        )
      }

      return Object.freeze({
        issues: Object.freeze([...issues]),
        success: false,
      })
    }

    // A missing value is not a successful validation of undefined. Reflect.has
    // still accepts conformant class results whose value getter is inherited.
    if (!Reflect.has(rawResult, "value")) {
      throw new TypeError(
        `${this.#label} returned a success result without a value`,
      )
    }

    const resultValue = Reflect.get(rawResult, "value")

    return Object.freeze({
      success: true,
      value: resultValue,
    })
  }
}
