import {
  AbstractAgentProvider,
  defineAgentProvider,
  type AgentExecutionContext,
  type AgentProvider,
  type AgentProviderSession,
  type AgentRequest,
  type SandboxSession,
  supportsSandboxRuntime,
} from "@aml-jsx/sdk"
import type { ProviderConfig } from "@earendil-works/pi-coding-agent"
import { defu } from "defu"

import { PiSdkSessionClientFactory } from "./pi-sdk-session-client.js"
import type {
  PiSessionClient,
  PiSessionClientFactory,
  PiSessionCreateInput,
  PiThinkingLevel,
} from "./pi-session-client.js"

const PI_HOST_TOOLS = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"])
const PI_THINKING_LEVELS = new Set<PiThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"])

/**
 * Configures Pi's SDK and invocation defaults.
 */
export interface PiAgentOptions {
  readonly clientFactory?: PiSessionClientFactory
  readonly model?: string
  readonly providers?: Readonly<Record<string, ProviderConfig>>
  readonly thinkingLevel?: PiThinkingLevel
  readonly workingDirectory?: string
}

/**
 * Configured Pi strategy used by `<Agent provider>`.
 */
export interface PiAgentProvider extends AgentProvider {
  readonly name: "pi"
}

interface CapturedPiAgentOptions {
  readonly clientFactory: PiSessionClientFactory
  readonly model?: string
  readonly providers?: Readonly<Record<string, ProviderConfig>>
  readonly thinkingLevel?: PiThinkingLevel
  readonly workingDirectory?: string
}

class PiAgentImplementation extends AbstractAgentProvider<"pi"> implements PiAgentProvider {
  readonly #clientFactory: PiSessionClientFactory
  readonly #clientFactoryCreate: PiSessionClientFactory["create"]
  readonly #model: string | undefined
  readonly #providers: Readonly<Record<string, ProviderConfig>> | undefined
  readonly #thinkingLevel: PiThinkingLevel | undefined
  readonly #workingDirectory: string | undefined
  constructor(options: CapturedPiAgentOptions) {
    super("pi")
    this.#clientFactory = options.clientFactory
    this.#clientFactoryCreate = options.clientFactory.create
    this.#model = options.model
    this.#providers = options.providers
    this.#thinkingLevel = options.thinkingLevel
    this.#workingDirectory = options.workingDirectory
  }

  /**
   * Accepts provider-neutral runtimes that enforce the effective Sandbox.
   */
  override supportsSandbox(sandbox: SandboxSession): boolean {
    return supportsSandboxRuntime(sandbox)
  }

  /**
   * Creates one fresh in-memory Pi session with invocation-wide capabilities.
   */
  protected async openSession(request: AgentRequest, context: AgentExecutionContext): Promise<AgentProviderSession> {
    context.signal.throwIfAborted()

    if (request.mcpServers.length > 0) {
      throw new Error("Pi Agent does not yet support AML MCP servers")
    }

    const requestedModel = validateModel(request.model)
    const tools = request.tools.map(tool => {
      if (tool.kind === "host") {
        if (!PI_HOST_TOOLS.has(tool.name)) {
          throw new Error(`Pi host Tool "${tool.name}" is unsupported`)
        }

        return tool.name
      }

      return {
        description: tool.description,
        execute: tool.execute,
        inputSchema: tool.inputSchema,
        name: tool.name,
      }
    })
    const sandbox = context.sandbox

    if (sandbox !== undefined && !supportsSandboxRuntime(sandbox)) {
      throw new Error("Pi Agent received an incompatible Sandbox runtime")
    }

    const defaults = {
      cwd: this.#workingDirectory ?? process.cwd(),
      ...(this.#model === undefined ? {} : { model: this.#model }),
      ...(this.#providers === undefined ? {} : { providers: this.#providers }),
      ...(this.#thinkingLevel === undefined ? {} : { thinkingLevel: this.#thinkingLevel }),
    }
    const userInputs = {
      ...(requestedModel === undefined ? {} : { model: requestedModel }),
    }
    const imperativeConfig = {
      ...(sandbox === undefined
        ? {}
        : {
            sandbox: Object.freeze({
              cwd: sandbox.cwd,
              runtime: sandbox.lease.runtime,
            }),
          }),
      system: request.system,
      tools: Object.freeze(tools),
      trace: context.trace,
    }
    // defu is priority-first: AML policy wins, authored input overrides
    // factory defaults, and provider-native nested tables remain intact.
    const input = Object.freeze(defu(imperativeConfig, userInputs, defaults)) as PiSessionCreateInput
    const session = await this.#createSession(input, context.signal)

    return {
      abort: async () => await session.abort(),
      close: async () => session.dispose(),
      async runTurn(turn) {
        const text = await session.prompt(turn.prompt, turn.output?.jsonSchema)

        if (turn.output === undefined) {
          return Object.freeze({ text })
        }

        let structured: unknown

        try {
          structured = JSON.parse(text)
        } catch (cause) {
          throw new TypeError("Pi structured response is not valid JSON", {
            cause,
          })
        }

        return Object.freeze({ structured, text })
      },
    }
  }

  /**
   * Calls the captured construction port and validates its session result.
   */
  async #createSession(input: PiSessionCreateInput, signal: AbortSignal): Promise<PiSessionClient> {
    const session = await Reflect.apply(this.#clientFactoryCreate, this.#clientFactory, [input, signal])

    if (typeof session !== "object" || session === null) {
      throw new TypeError("Pi clientFactory must return a session object")
    }

    for (const method of ["abort", "dispose", "prompt"] as const) {
      if (typeof session[method] !== "function") {
        throw new TypeError(`Pi session ${method} must be a function`)
      }
    }

    return session
  }
}

/**
 * Configures one immutable Pi Agent adapter without performing I/O.
 */
export function piAgent(options: PiAgentOptions = {}): PiAgentProvider {
  return defineAgentProvider(new PiAgentImplementation(captureOptions(options)))
}

/**
 * Validates and snapshots provider configuration at the factory boundary.
 */
function captureOptions(options: PiAgentOptions): CapturedPiAgentOptions {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Pi Agent options must be an object")
  }

  const clientFactoryValue = options.clientFactory
  const model = validateModel(options.model)
  const providers = captureProviders(options.providers)
  const thinkingLevel = options.thinkingLevel
  const workingDirectory = optionalNormalizedString(options.workingDirectory, "Pi workingDirectory")

  if (thinkingLevel !== undefined && !PI_THINKING_LEVELS.has(thinkingLevel)) {
    throw new TypeError("Pi thinkingLevel is unsupported")
  }

  const clientFactory = clientFactoryValue === undefined ? new PiSdkSessionClientFactory() : clientFactoryValue

  if (typeof clientFactory !== "object" || clientFactory === null || typeof clientFactory.create !== "function") {
    throw new TypeError("Pi clientFactory create must be a function")
  }

  return Object.freeze({
    clientFactory,
    ...(model === undefined ? {} : { model }),
    ...(providers === undefined ? {} : { providers }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  })
}

function validateModel(value: string | undefined): string | undefined {
  return optionalNormalizedString(value, "Pi model")
}

function optionalNormalizedString(value: string | undefined, label: string): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty normalized string`)
  }

  return value
}

/**
 * Captures Pi's native provider map while preserving its callback identities.
 */
function captureProviders(
  value: Readonly<Record<string, ProviderConfig>> | undefined
): Readonly<Record<string, ProviderConfig>> | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Pi providers must be an object")
  }

  const providers: Record<string, ProviderConfig> = {}

  for (const providerId of Object.keys(value)) {
    if (providerId.length === 0 || providerId !== providerId.trim()) {
      throw new TypeError("Pi provider IDs must be non-empty normalized strings")
    }

    const config = value[providerId]

    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      throw new TypeError(`Pi provider "${providerId}" config must be an object`)
    }

    providers[providerId] = captureProviderValue(config, `Pi provider "${providerId}"`) as ProviderConfig
  }

  return Object.freeze(providers)
}

/**
 * Recursively snapshots native Pi data while retaining provider callback identities.
 */
function captureProviderValue(value: unknown, label: string, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") {
    return value
  }

  if (seen.has(value)) {
    throw new TypeError(`${label} must not contain cycles`)
  }

  seen.add(value)

  if (Array.isArray(value)) {
    const captured = value.map(item => captureProviderValue(item, label, seen))
    seen.delete(value)
    return Object.freeze(captured)
  }

  const captured: Record<string, unknown> = {}

  for (const key of Object.keys(value)) {
    captured[key] = captureProviderValue(Reflect.get(value, key), label, seen)
  }

  seen.delete(value)
  return Object.freeze(captured)
}
