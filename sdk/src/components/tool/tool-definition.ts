import type { StandardSchemaV1 } from "@standard-schema/spec"

import type { AmlJsonValue } from "../../core/aml-json-value.js"
import type {
  AgentJavaScriptTool,
  AgentToolExecutionContext,
  AmlTool,
  AmlToolSchema,
} from "./agent-tool.js"
import { registerAmlTool } from "./agent-tool.js"
import { JsonSnapshot } from "./json-snapshot.js"
import {
  StandardSchemaAdapter,
  type SchemaValidation,
} from "./standard-schema-adapter.js"
import { ToolInputError } from "./tool-input-error.js"
import { ToolOutputError } from "./tool-output-error.js"

interface ToolDefinitionOptions {
  readonly description: string
  readonly execute: (
    input: unknown,
    context: AgentToolExecutionContext,
  ) => unknown
  readonly input: AmlToolSchema
  readonly name: string
  readonly output?: StandardSchemaV1
}

/**
 * Owns schema conversion, transport normalization, and Tool result safety.
 */
export class ToolDefinition implements AmlTool {
  readonly #execute: ToolDefinitionOptions["execute"]
  readonly #input: StandardSchemaAdapter
  readonly #output: StandardSchemaAdapter | undefined
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly kind = "javascript" as const
  readonly name: string
  declare readonly __amlTool: true

  /**
   * Captures the authored function, schemas, and immutable model declaration.
   */
  constructor(options: ToolDefinitionOptions) {
    validateNormalizedText(options.name, "Tool name")
    validateNormalizedText(options.description, "Tool description")

    if (typeof options.execute !== "function") {
      throw new TypeError("Tool execute must be a function")
    }

    this.#input = new StandardSchemaAdapter(options.input, true)
    this.#output =
      options.output === undefined
        ? undefined
        : new StandardSchemaAdapter(options.output, false)
    this.#execute = options.execute
    this.name = options.name
    this.description = options.description

    // Providers see a stable declaration even if the schema implementation
    // returns mutable objects or changes its conversion result later.
    let inputSchema: AmlJsonValue

    try {
      inputSchema = JsonSnapshot.capture(
        this.#input.inputJsonSchema(),
        `Tool "${this.name}" input JSON Schema`,
      )
    } catch (cause) {
      throw new TypeError(
        `Tool "${this.name}" input JSON Schema is invalid`,
        { cause },
      )
    }

    if (
      typeof inputSchema !== "object" ||
      inputSchema === null ||
      Array.isArray(inputSchema)
    ) {
      throw new TypeError(
        `Tool "${this.name}" input JSON Schema must be an object`,
      )
    }

    const inputSchemaObject =
      inputSchema as Readonly<Record<string, AmlJsonValue>>

    this.inputSchema = inputSchemaObject
    Object.defineProperty(this, "__amlTool", { value: true })

    // The registry stores a separate frozen port whose closure reaches the
    // private validator directly. Public method replacement cannot alter the
    // execution path later consumed by ToolCollection.
    const execution: AgentJavaScriptTool = Object.freeze({
      description: this.description,
      execute: async (
        input: unknown,
        context: AgentToolExecutionContext,
      ) =>
        await this.#executeValidated(input, context),
      inputSchema: this.inputSchema,
      kind: this.kind,
      name: this.name,
    })

    registerAmlTool(this, execution)
    Object.freeze(this)
  }

  /**
   * Validates transport input, invokes application code, and snapshots output.
   */
  async execute(
    input: unknown,
    context: AgentToolExecutionContext,
  ): Promise<AmlJsonValue> {
    return await this.#executeValidated(input, context)
  }

  /**
   * SDK-owned execution path retained in the exact-identity registry.
   */
  async #executeValidated(
    input: unknown,
    context: AgentToolExecutionContext,
  ): Promise<AmlJsonValue> {
    const normalizedInput = await this.#normalizeInput(input)
    const rawOutput = await Reflect.apply(this.#execute, undefined, [
      normalizedInput,
      context,
    ])
    const output = this.#output
      ? await this.#validateOutput(rawOutput)
      : rawOutput

    try {
      return JsonSnapshot.capture(output, `Tool "${this.name}" output`)
    } catch (cause) {
      throw new ToolOutputError(
        `Tool "${this.name}" output is not valid JSON`,
        { cause },
      )
    }
  }

  /**
   * Applies AML's exact direct, omitted-object, then one-time JSON algorithm.
   */
  async #normalizeInput(input: unknown): Promise<unknown> {
    // Direct acceptance wins, especially for string schemas whose valid values
    // may themselves happen to contain JSON text.
    const initial = await this.#validateInput(input)

    if (initial.success) {
      return initial.value
    }

    if (input === undefined) {
      // Omitted provider arguments mean {} only when the schema accepts it.
      const empty = await this.#validateInput({})

      if (empty.success) {
        return empty.value
      }
    }

    if (typeof input === "string") {
      let decoded: unknown

      // Decode a rejected string once. Nested stringified values are not
      // recursively coerced because the authored schema remains authoritative.
      try {
        decoded = JSON.parse(input)
      } catch (cause) {
        throw new ToolInputError(
          `Tool "${this.name}" input is neither valid directly nor valid JSON`,
          { cause },
        )
      }

      const parsed = await this.#validateInput(decoded)

      if (parsed.success) {
        return parsed.value
      }
    }

    throw new ToolInputError(
      `Tool "${this.name}" input failed schema validation`,
      { cause: initial.issues },
    )
  }

  /**
   * Reclassifies schema implementation failures as Tool input failures.
   */
  async #validateInput(value: unknown): Promise<SchemaValidation> {
    try {
      return await this.#input.validate(value)
    } catch (cause) {
      throw new ToolInputError(
        `Tool "${this.name}" input schema failed`,
        { cause },
      )
    }
  }

  /**
   * Applies the optional output schema before the JSON snapshot boundary.
   */
  async #validateOutput(value: unknown): Promise<unknown> {
    let result: SchemaValidation

    try {
      result = await this.#output!.validate(value)
    } catch (cause) {
      throw new ToolOutputError(
        `Tool "${this.name}" output schema failed`,
        { cause },
      )
    }

    if (!result.success) {
      throw new ToolOutputError(
        `Tool "${this.name}" output failed schema validation`,
        { cause: result.issues },
      )
    }

    return result.value
  }
}

/**
 * Rejects whitespace-normalized configuration before a Tool is registered.
 */
function validateNormalizedText(value: unknown, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new TypeError(
      `${label} must be a non-empty normalized string`,
    )
  }
}
