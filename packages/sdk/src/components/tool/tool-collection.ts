import { EvaluationError } from "../../core/evaluation-error.js"
import type {
  AgentTool,
  AgentToolExecutionContext,
  AmlJsonValue,
} from "./agent-tool.js"
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
    const name = Reflect.get(props, "name")
    const use = Reflect.get(props, "use")

    if (children !== undefined) {
      throw new EvaluationError("<Tool> does not accept children")
    }

    if ((name === undefined) === (use === undefined)) {
      throw new EvaluationError(
        "<Tool> requires exactly one of name or use",
      )
    }

    // Host Tools and JavaScript Tools share names but have different trust and
    // execution owners, so normalize them through separate boundaries.
    const tool =
      use === undefined
        ? this.#hostTool(name)
        : this.#javaScriptTool(use)

    if (this.#names.has(tool.name)) {
      throw new EvaluationError(
        `Agent declares duplicate Tool "${tool.name}"`,
      )
    }

    if (
      this.#allowedTools &&
      !this.#allowedTools.has(tool.name)
    ) {
      throw new EvaluationError(
        `Tool "${tool.name}" is not allowed by this runtime`,
      )
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
   * Captures a provider-owned Tool name after applying portable name rules.
   */
  #hostTool(name: unknown): AgentTool {
    validateName(name)
    return Object.freeze({ kind: "host", name })
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
    const {
      description,
      execute,
      inputSchema,
      kind,
      name,
    } = registered
    let schemaSnapshot: AmlJsonValue

    try {
      schemaSnapshot = JsonSnapshot.capture(
        inputSchema,
        `Tool "${name}" input JSON Schema`,
      )
    } catch (cause) {
      throw new EvaluationError(
        `<Tool use> "${name}" has an invalid input JSON Schema`,
        { cause },
      )
    }

    if (
      typeof schemaSnapshot !== "object" ||
      schemaSnapshot === null ||
      Array.isArray(schemaSnapshot)
    ) {
      throw new EvaluationError(
        `<Tool use> "${name}" has an invalid input JSON Schema`,
      )
    }

    // Re-snapshot results at the collection boundary as defense in depth for
    // cross-copy Tool definitions and third-party provider transports.
    return Object.freeze({
      description,
      execute: async (
        input: unknown,
        context: AgentToolExecutionContext,
      ) => {
        const output = await Reflect.apply(execute, registered, [
          input,
          context,
        ])

        try {
          return JsonSnapshot.capture(output, `Tool "${name}" output`)
        } catch (cause) {
          throw new ToolOutputError(
            `Tool "${name}" output is not valid JSON`,
            { cause },
          )
        }
      },
      inputSchema:
        schemaSnapshot as Readonly<Record<string, AmlJsonValue>>,
      kind,
      name,
    })
  }
}

/**
 * Enforces the shared normalized capability-name contract.
 */
function validateName(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new EvaluationError(
      "Tool name must be a non-empty normalized string",
    )
  }
}
