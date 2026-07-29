import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"

import type {
  PiJavaScriptTool,
  PiSessionClient,
  PiSessionClientFactory,
  PiSessionCreateInput,
} from "./pi-session-client.js"
import { createPiSandboxTools } from "./pi-sandbox-bash.js"

const JSON_OUTPUT_INSTRUCTION =
  "Return only a JSON value matching this JSON Schema. Do not wrap it in Markdown or add explanatory text:"

/**
 * Constructs isolated, in-memory Pi SDK sessions for AML Agent invocations.
 */
export class PiSdkSessionClientFactory implements PiSessionClientFactory {
  async create(input: PiSessionCreateInput, signal: AbortSignal): Promise<PiSessionClient> {
    signal.throwIfAborted()

    const modelRuntime = await ModelRuntime.create()
    const modelIdentity = PiSdkSessionClientFactory.#modelIdentity(input.model)

    for (const [providerId, config] of Object.entries(input.providers ?? {})) {
      modelRuntime.registerProvider(providerId, config)
    }

    const model =
      modelIdentity === undefined ? undefined : modelRuntime.getModel(modelIdentity.provider, modelIdentity.model)

    if (modelIdentity !== undefined && model === undefined) {
      throw new Error(`Pi model "${input.model}" is unavailable`)
    }

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    })
    const resourceLoader = new DefaultResourceLoader({
      agentDir: input.cwd,
      cwd: input.cwd,
      noContextFiles: true,
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      settingsManager,
      systemPrompt: input.system,
    })
    await resourceLoader.reload()
    signal.throwIfAborted()

    const hostTools = input.tools.filter((tool): tool is string => typeof tool === "string")
    const javaScriptTools = input.tools.filter((tool): tool is PiJavaScriptTool => typeof tool !== "string")
    const customTools = [
      ...javaScriptTools.map(tool => PiSdkSessionClientFactory.#customTool(tool, input, signal)),
      ...(input.sandbox === undefined ? [] : createPiSandboxTools(hostTools, input.sandbox)),
    ]
    const { session } = await createAgentSession({
      cwd: input.cwd,
      customTools,
      ...(model === undefined ? {} : { model }),
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
      tools: [...hostTools, ...javaScriptTools.map(tool => tool.name)],
    })

    return new PiSdkSessionClient(session)
  }

  /**
   * Translates one AML JavaScript Tool into Pi's TypeBox-shaped definition.
   */
  static #customTool(tool: PiJavaScriptTool, input: PiSessionCreateInput, signal: AbortSignal): ToolDefinition {
    return defineTool({
      description: tool.description,
      label: tool.name,
      name: tool.name,
      parameters: tool.inputSchema as never,
      // Pi omits custom Tools from its default prompt unless they declare the
      // one-line capability snippet used by its Available tools section.
      promptSnippet: tool.description,
      async execute(_toolCallId, params) {
        const result = await tool.execute(params, {
          signal,
          trace: input.trace,
        })
        const text = typeof result === "string" ? result : JSON.stringify(result)

        return {
          content: [{ type: "text", text }],
          details: result,
        }
      },
    })
  }

  /**
   * Splits Pi's provider/model identity without normalizing either segment.
   */
  static #modelIdentity(value: string | undefined): { model: string; provider: string } | undefined {
    if (value === undefined) {
      return undefined
    }

    const separator = value.indexOf("/")

    if (separator <= 0 || separator === value.length - 1) {
      throw new TypeError('Pi model must use the "provider/model" format')
    }

    return {
      model: value.slice(separator + 1),
      provider: value.slice(0, separator),
    }
  }
}

/**
 * Adapts one concrete Pi AgentSession into AML's narrow session port.
 */
class PiSdkSessionClient implements PiSessionClient {
  readonly #session: AgentSession

  constructor(session: AgentSession) {
    this.#session = session
  }

  async abort(): Promise<void> {
    await this.#session.abort()
  }

  dispose(): void {
    this.#session.dispose()
  }

  async prompt(prompt: string, outputSchema?: Readonly<Record<string, unknown>>): Promise<string> {
    const authoredPrompt =
      outputSchema === undefined ? prompt : [prompt, JSON_OUTPUT_INSTRUCTION, JSON.stringify(outputSchema)].join("\n\n")
    await this.#session.prompt(authoredPrompt, {
      expandPromptTemplates: false,
    })
    const message = [...this.#session.messages].reverse().find(candidate => candidate.role === "assistant")

    if (message === undefined || message.role !== "assistant") {
      throw new Error("Pi session produced no assistant response")
    }

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage ?? `Pi session stopped with ${message.stopReason}`)
    }

    return message.content
      .filter(
        (content): content is Extract<(typeof message.content)[number], { type: "text" }> => content.type === "text"
      )
      .map(content => content.text)
      .join("")
  }
}
