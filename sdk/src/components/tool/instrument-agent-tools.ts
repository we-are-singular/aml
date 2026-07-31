import type { AmlJsonValue } from "../../core/aml-json-value.js"
import type { EvaluationContext } from "../../core/evaluation-context.js"
import type { AmlTraceIdentity } from "../../core/trace-identity.js"
import type { AgentTool, AgentToolExecutionContext } from "./agent-tool.js"
import { JsonSnapshot } from "./json-snapshot.js"
import { ToolInputError } from "./tool-input-error.js"

/**
 * Adds runtime-owned trace spans around JavaScript Tools.
 */
export function instrumentAgentTools(
  tools: readonly AgentTool[],
  context: EvaluationContext,
  parent: AmlTraceIdentity
): readonly AgentTool[] {
  return Object.freeze(
    tools.map((tool): AgentTool => {
      return Object.freeze({
        description: tool.description,
        async execute(input: unknown, executionContext: AgentToolExecutionContext) {
          const trace = context.createObservationTrace(parent.spanId)
          let capturedInput: AmlJsonValue | undefined

          try {
            // Capture provider input once so tracing cannot alter Tool data.
            capturedInput =
              input === undefined ? undefined : JsonSnapshot.capture(input, `Tool "${tool.name}" transport input`)
          } catch (cause) {
            const error = new ToolInputError(`Tool "${tool.name}" input is not valid JSON`, { cause })
            const span = context.startTraceSpan(trace, "tool", tool.name)

            context.failTraceSpan(span, error)
            throw error
          }

          const serializedInput = context.capturesTraceContent ? serializeJson(capturedInput) : undefined
          const span = context.startTraceSpan(
            trace,
            "tool",
            tool.name,
            {},
            serializedInput === undefined ? {} : { input: serializedInput }
          )

          try {
            const output = await Reflect.apply(tool.execute, tool, [
              capturedInput,
              Object.freeze({
                // Providers may narrow cancellation for one Tool call.
                signal: executionContext.signal,
                trace,
              }),
            ])
            const serializedOutput = context.capturesTraceContent ? serializeJson(output) : undefined

            context.endTraceSpan(span, "ok", {}, serializedOutput === undefined ? {} : { output: serializedOutput })
            return output
          } catch (error) {
            context.failTraceSpan(span, error)
            throw error
          }
        },
        inputSchema: tool.inputSchema,
        kind: tool.kind,
        name: tool.name,
      })
    })
  )
}

/**
 * Serializes optional trace content without changing Tool execution.
 */
function serializeJson(value: AmlJsonValue | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  try {
    return JSON.stringify(value)
  } catch {
    // Deep JSON can exceed the native serializer stack. Content is optional.
    return undefined
  }
}
