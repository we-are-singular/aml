import type { StandardSchemaV1 } from "@standard-schema/spec"

import type { AmlJsonValue } from "../../core/aml-json-value.js"
import { ComponentEvaluationContext } from "../../core/component-evaluation-context.js"
import type { AgentJavaScriptTool, AgentToolExecutionContext, AmlTool, AmlToolSchema } from "./agent-tool.js"
import { registerAmlTool } from "./agent-tool.js"
import { JsonSnapshot } from "./json-snapshot.js"
import { StandardSchemaAdapter, type SchemaValidation } from "./standard-schema-adapter.js"
import { ToolInputError } from "./tool-input-error.js"
import { ToolOutputError } from "./tool-output-error.js"

type MaybePromise<Value> = PromiseLike<Value> | Value

interface DefineToolBase<InputSchema extends AmlToolSchema> {
  readonly description: string
  readonly input: InputSchema
  readonly name: string
}

/**
 * Author-facing Tool contract with input and optional output inference.
 */
export type DefineToolOptions<
  InputSchema extends AmlToolSchema,
  OutputSchema extends StandardSchemaV1 | undefined = undefined,
> = DefineToolBase<InputSchema> &
  (OutputSchema extends StandardSchemaV1
    ? {
        readonly execute: (
          input: StandardSchemaV1.InferOutput<InputSchema>,
          context: AgentToolExecutionContext
        ) => MaybePromise<StandardSchemaV1.InferInput<OutputSchema>>
        readonly output: OutputSchema
      }
    : {
        readonly execute: (
          input: StandardSchemaV1.InferOutput<InputSchema>,
          context: AgentToolExecutionContext
        ) => MaybePromise<AmlJsonValue>
        readonly output?: undefined
      })

/**
 * Defines one immutable, schema-validated callable JavaScript Tool.
 *
 * Calling the result invokes it through the active AML function component.
 * Its execute method retains the explicit low-level provider and test API.
 */
export function defineTool<
  InputSchema extends AmlToolSchema,
  OutputSchema extends StandardSchemaV1 | undefined = undefined,
>(
  options: DefineToolOptions<InputSchema, OutputSchema>
): AmlTool<
  StandardSchemaV1.InferInput<InputSchema>,
  OutputSchema extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<OutputSchema> : AmlJsonValue
> {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("defineTool options must be an object")
  }

  // Capture each public option exactly once at the authoring boundary.
  const description = Reflect.get(options, "description")
  const authoredExecute = Reflect.get(options, "execute")
  const input = Reflect.get(options, "input")
  const name = Reflect.get(options, "name")
  const output = Reflect.get(options, "output")

  validateNormalizedText(name, "Tool name")
  validateNormalizedText(description, "Tool description")

  if (typeof authoredExecute !== "function") {
    throw new TypeError("Tool execute must be a function")
  }

  const inputAdapter = new StandardSchemaAdapter(input as AmlToolSchema, true)
  const outputAdapter = output === undefined ? undefined : new StandardSchemaAdapter(output as StandardSchemaV1, false)
  const inputSchema = captureInputSchema(name, inputAdapter)

  const execute = async (value: unknown, context: AgentToolExecutionContext): Promise<AmlJsonValue> => {
    const normalizedInput = await normalizeInput(value, name, inputAdapter)
    const rawOutput = await Reflect.apply(authoredExecute, undefined, [normalizedInput, context])
    const validatedOutput =
      outputAdapter === undefined ? rawOutput : await validateOutput(rawOutput, name, outputAdapter)

    try {
      return JsonSnapshot.capture(validatedOutput, `Tool "${name}" output`)
    } catch (cause) {
      throw new ToolOutputError(`Tool "${name}" output is not valid JSON`, { cause })
    }
  }

  type ToolInput = StandardSchemaV1.InferInput<InputSchema>
  type ToolOutput = OutputSchema extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<OutputSchema> : AmlJsonValue

  const tool = ((value: ToolInput) => ComponentEvaluationContext.callTool(tool, value)) as AmlTool<
    ToolInput,
    ToolOutput
  >

  Object.defineProperties(tool, {
    __amlTool: { value: true },
    description: { enumerable: true, value: description },
    execute: { enumerable: true, value: execute },
    inputSchema: { enumerable: true, value: inputSchema },
    kind: { enumerable: true, value: "javascript" },
    name: { enumerable: true, value: name },
  })

  // Model grants and application calls resolve this same immutable execution
  // port, keeping validation and result safety on one SDK-owned path.
  const execution: AgentJavaScriptTool = Object.freeze({
    description,
    execute,
    inputSchema,
    kind: "javascript",
    name,
  })

  registerAmlTool(tool, execution)
  return Object.freeze(tool)
}

/** Captures the stable model-facing declaration during Tool definition. */
function captureInputSchema(name: string, input: StandardSchemaAdapter): Readonly<Record<string, AmlJsonValue>> {
  let schema: AmlJsonValue

  try {
    schema = JsonSnapshot.capture(input.inputJsonSchema(), `Tool "${name}" input JSON Schema`)
  } catch (cause) {
    throw new TypeError(`Tool "${name}" input JSON Schema is invalid`, { cause })
  }

  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new TypeError(`Tool "${name}" input JSON Schema must be an object`)
  }

  return schema as Readonly<Record<string, AmlJsonValue>>
}

/** Applies AML's direct, omitted-object, then one-time JSON input algorithm. */
async function normalizeInput(input: unknown, name: string, schema: StandardSchemaAdapter): Promise<unknown> {
  // Direct acceptance wins, especially for string schemas whose valid values
  // may themselves happen to contain JSON text.
  const initial = await validateInput(input, name, schema)

  if (initial.success) {
    return initial.value
  }

  if (input === undefined) {
    // Omitted provider arguments mean {} only when the schema accepts it.
    const empty = await validateInput({}, name, schema)

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
      throw new ToolInputError(`Tool "${name}" input is neither valid directly nor valid JSON`, { cause })
    }

    const parsed = await validateInput(decoded, name, schema)

    if (parsed.success) {
      return parsed.value
    }
  }

  throw new ToolInputError(`Tool "${name}" input failed schema validation`, { cause: initial.issues })
}

/** Reclassifies schema implementation failures as Tool input failures. */
async function validateInput(value: unknown, name: string, schema: StandardSchemaAdapter): Promise<SchemaValidation> {
  try {
    return await schema.validate(value)
  } catch (cause) {
    throw new ToolInputError(`Tool "${name}" input schema failed`, { cause })
  }
}

/** Applies the optional output schema before the JSON snapshot boundary. */
async function validateOutput(value: unknown, name: string, schema: StandardSchemaAdapter): Promise<unknown> {
  let result: SchemaValidation

  try {
    result = await schema.validate(value)
  } catch (cause) {
    throw new ToolOutputError(`Tool "${name}" output schema failed`, { cause })
  }

  if (!result.success) {
    throw new ToolOutputError(`Tool "${name}" output failed schema validation`, { cause: result.issues })
  }

  return result.value
}

/** Rejects whitespace-normalized configuration before registration. */
function validateNormalizedText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty normalized string`)
  }
}
