import type { StandardSchemaV1 } from "@standard-schema/spec"

import type { AmlJsonValue } from "../../core/aml-json-value.js"
import type { AgentToolExecutionContext, AmlTool, AmlToolSchema } from "./agent-tool.js"
import { ToolDefinition } from "./tool-definition.js"

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
 * Defines one immutable, schema-validated JavaScript Tool.
 *
 * Configuration properties are captured once so getters or later mutations
 * cannot change the capability contract between definition and execution.
 */
export function defineTool<
  InputSchema extends AmlToolSchema,
  OutputSchema extends StandardSchemaV1 | undefined = undefined,
>(options: DefineToolOptions<InputSchema, OutputSchema>): AmlTool {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("defineTool options must be an object")
  }

  // Capture each public option exactly once at the authoring boundary.
  const description = Reflect.get(options, "description")
  const execute = Reflect.get(options, "execute")
  const input = Reflect.get(options, "input")
  const name = Reflect.get(options, "name")
  const output = Reflect.get(options, "output")

  return new ToolDefinition({
    description,
    execute,
    input,
    name,
    ...(output === undefined ? {} : { output }),
  } as never)
}
