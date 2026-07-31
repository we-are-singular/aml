import { EvaluationError } from "../../core/evaluation-error.js"
import type { AmlJsonValue } from "../../core/aml-json-value.js"
import type { AgentTool, AgentToolExecutionContext } from "./agent-tool.js"
import { registeredAmlTool } from "./agent-tool.js"
import { JsonSnapshot } from "./json-snapshot.js"
import type { ToolProps } from "./tool.js"
import { ToolOutputError } from "./tool-output-error.js"

/**
 * Owns one Agent's capability scope and duplicate/allowlist checks.
 */
export class ToolCollection {
  readonly #allowedTools: ReadonlySet<string> | undefined
  readonly #names = new Set<string>()
  readonly #tools: AgentTool[] = []

  /**
   * Creates one collection for the nearest containing Agent.
   */
  constructor(allowedTools?: ReadonlySet<string>) {
    this.#allowedTools = allowedTools
  }

  /**
   * Validates and adds one authored Tool grant without producing prompt text.
   */
  add(props: Readonly<ToolProps>): void {
    const children = Reflect.get(props, "children")
    const use = Reflect.get(props, "use")

    if (children !== undefined) {
      throw new EvaluationError("<Tool> does not accept children")
    }

    if (use === undefined || Reflect.has(props, "name")) {
      throw new EvaluationError("<Tool> requires exactly one JavaScript Tool through use")
    }

    const tool = this.#javaScriptTool(use)

    if (this.#names.has(tool.name)) {
      throw new EvaluationError(`Agent declares duplicate Tool "${tool.name}"`)
    }

    if (this.#allowedTools && !this.#allowedTools.has(tool.name)) {
      throw new EvaluationError(`Tool "${tool.name}" is not allowed by this runtime`)
    }

    this.#names.add(tool.name)
    this.#tools.push(tool)
  }

  /**
   * Returns an immutable snapshot for the provider request.
   */
  values(): readonly AgentTool[] {
    return Object.freeze([...this.#tools])
  }

  /**
   * Adds one runtime-owned capability without applying the author allowlist.
   *
   * Loop state is not an application-selected grant: `<Loop>` requires AML to
   * provide it. It still shares the Agent namespace and therefore cannot
   * silently replace an authored capability with the same name.
   */
  addRuntime(tool: AgentTool): void {
    if (this.#names.has(tool.name)) {
      throw new EvaluationError(`Agent declares duplicate Tool "${tool.name}"`)
    }

    this.#names.add(tool.name)
    this.#tools.push(tool)
  }

  /**
   * Recovers the immutable SDK-owned port for one exact defineTool() identity.
   */
  #javaScriptTool(value: unknown): AgentTool {
    const registered = registeredAmlTool(value)

    if (!registered) {
      throw new EvaluationError("<Tool use> must be a JavaScript Tool")
    }

    // Use only the frozen execution port from the exact-identity registry.
    // Clones, derived objects, proxies, and replaced public methods never reach
    // this point or application code.
    const { description, execute, inputSchema, kind, name } = registered
    let schemaSnapshot: AmlJsonValue

    try {
      schemaSnapshot = JsonSnapshot.capture(inputSchema, `Tool "${name}" input JSON Schema`)
    } catch (cause) {
      throw new EvaluationError(`<Tool use> "${name}" has an invalid input JSON Schema`, { cause })
    }

    if (typeof schemaSnapshot !== "object" || schemaSnapshot === null || Array.isArray(schemaSnapshot)) {
      throw new EvaluationError(`<Tool use> "${name}" has an invalid input JSON Schema`)
    }

    // Re-snapshot results at the collection boundary as defense in depth for
    // cross-copy Tool definitions and third-party provider transports.
    return Object.freeze({
      description,
      execute: async (input: unknown, context: AgentToolExecutionContext) => {
        const output = await Reflect.apply(execute, registered, [input, context])

        try {
          return JsonSnapshot.capture(output, `Tool "${name}" output`)
        } catch (cause) {
          throw new ToolOutputError(`Tool "${name}" output is not valid JSON`, { cause })
        }
      },
      inputSchema: schemaSnapshot as Readonly<Record<string, AmlJsonValue>>,
      kind,
      name,
    })
  }
}
