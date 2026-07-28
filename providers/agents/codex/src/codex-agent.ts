import {
  defineAgentProvider,
  type AgentExecutionContext,
  type AgentProvider,
  type AgentRequest,
  type AgentResponse,
} from "@aml-jsx/sdk"

import { CodexCapabilityAttachment } from "./codex-capability-attachment.js"
import type {
  CodexClient,
  CodexClientFactory,
  CodexClientOptions,
  CodexConfig,
  CodexConfigValue,
  CodexReasoningEffort,
} from "./codex-client-factory.js"
import { CodexSdkClientFactory } from "./codex-sdk-client-factory.js"
import { CodexSession } from "./codex-session.js"

const REASONING_EFFORTS = new Set<CodexReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"])

const MAX_CODEX_CONFIG_DEPTH = 128

/**
 * Configures the Codex SDK and its provider-owned execution defaults.
 */
export interface CodexAgentOptions {
  readonly apiKey?: string
  readonly baseUrl?: string
  readonly clientFactory?: CodexClientFactory
  readonly codexPathOverride?: string
  readonly config?: CodexConfig
  readonly env?: Readonly<Record<string, string>>
  readonly model?: string
  readonly reasoningEffort?: CodexReasoningEffort
  readonly skipGitRepoCheck?: boolean
  readonly workingDirectory?: string
}

/**
 * Configured Codex strategy used by `<Agent provider>`.
 */
export interface CodexAgentProvider extends AgentProvider {
  readonly name: "codex"
}

interface CapturedCodexAgentOptions {
  readonly apiKey?: string
  readonly baseUrl?: string
  readonly clientFactory: CodexClientFactory
  readonly codexPathOverride?: string
  readonly config: CodexConfig
  readonly env?: Readonly<Record<string, string>>
  readonly model?: string
  readonly reasoningEffort?: CodexReasoningEffort
  readonly skipGitRepoCheck?: boolean
  readonly workingDirectory?: string
}

class CodexAgentImplementation implements CodexAgentProvider {
  readonly #apiKey: string | undefined
  readonly #baseUrl: string | undefined
  readonly #clientFactory: CodexClientFactory
  readonly #clientFactoryCreate: CodexClientFactory["create"]
  readonly #codexPathOverride: string | undefined
  readonly #config: CodexConfig
  readonly #env: Readonly<Record<string, string>> | undefined
  readonly #model: string | undefined
  readonly #reasoningEffort: CodexReasoningEffort | undefined
  readonly #skipGitRepoCheck: boolean | undefined
  readonly #workingDirectory: string | undefined
  readonly name = "codex" as const

  /**
   * Captures immutable configuration without constructing the Codex SDK.
   */
  constructor(options: CapturedCodexAgentOptions) {
    this.#apiKey = options.apiKey
    this.#baseUrl = options.baseUrl
    this.#clientFactory = options.clientFactory
    this.#clientFactoryCreate = options.clientFactory.create
    this.#codexPathOverride = options.codexPathOverride
    this.#config = options.config
    this.#env = options.env
    this.#model = options.model
    this.#reasoningEffort = options.reasoningEffort
    this.#skipGitRepoCheck = options.skipGitRepoCheck
    this.#workingDirectory = options.workingDirectory
  }

  /**
   * Runs one fresh Codex thread with invocation-local capabilities.
   */
  async run(request: AgentRequest, context: AgentExecutionContext): Promise<AgentResponse> {
    context.signal.throwIfAborted()

    if (typeof request.system !== "string") {
      throw new TypeError("Codex system must be a string")
    }

    // Constructing the plan first makes invalid FollowUps and models fail
    // before the optional localhost Tool bridge performs external work.
    const session = new CodexSession(request, {
      ...(this.#model === undefined ? {} : { model: this.#model }),
      ...(this.#reasoningEffort === undefined ? {} : { reasoningEffort: this.#reasoningEffort }),
      ...(this.#skipGitRepoCheck === undefined ? {} : { skipGitRepoCheck: this.#skipGitRepoCheck }),
      ...(this.#workingDirectory === undefined ? {} : { workingDirectory: this.#workingDirectory }),
    })
    // This table contains only explicit factory options. Ambient repository
    // and user MCP configuration remains visible only to the Codex host.
    const suppliedMcpOverrides = CodexAgentImplementation.#configTable(
      this.#config.mcp_servers,
      "Codex config mcp_servers"
    )
    const attachment = await CodexCapabilityAttachment.create(request, context, suppliedMcpOverrides)
    let hasExecutionError = false
    let executionError: unknown
    let response: AgentResponse | undefined

    // Execution and capability cleanup are tracked independently so a failed
    // Tool bridge shutdown cannot erase the original provider failure.
    try {
      const config = this.#invocationConfig(request, attachment, suppliedMcpOverrides)
      const client = this.#createClient({
        ...(this.#apiKey === undefined ? {} : { apiKey: this.#apiKey }),
        ...(this.#baseUrl === undefined ? {} : { baseUrl: this.#baseUrl }),
        ...(this.#codexPathOverride === undefined ? {} : { codexPathOverride: this.#codexPathOverride }),
        config,
        ...(this.#env === undefined ? {} : { env: this.#env }),
      })
      response = await session.run(client, context)
    } catch (error) {
      hasExecutionError = true
      executionError = error
    }

    let hasCleanupError = false
    let cleanupError: unknown

    try {
      await attachment.close()
    } catch (error) {
      hasCleanupError = true
      cleanupError = error
    }

    if (hasExecutionError && hasCleanupError) {
      throw new AggregateError([executionError, cleanupError], "Codex Agent execution and capability cleanup failed")
    }

    if (hasExecutionError) {
      throw executionError
    }

    if (hasCleanupError) {
      throw cleanupError
    }

    if (!response) {
      throw new Error("Codex Agent produced no response")
    }

    return response
  }

  /**
   * Calls the captured dependency-injection port and validates its result.
   */
  #createClient(options: CodexClientOptions): CodexClient {
    const client = Reflect.apply(this.#clientFactoryCreate, this.#clientFactory, [options]) as CodexClient

    if (typeof client !== "object" || client === null) {
      throw new TypeError("Codex clientFactory must return a client object")
    }

    return client
  }

  /**
   * Applies AML's invocation policy after provider-specific base config.
   */
  #invocationConfig(
    request: AgentRequest,
    attachment: CodexCapabilityAttachment,
    suppliedMcpOverrides: Readonly<Record<string, CodexConfigValue>>
  ): CodexConfig {
    const agents = CodexAgentImplementation.#configTable(this.#config.agents, "Codex config agents")
    const features = CodexAgentImplementation.#configTable(this.#config.features, "Codex config features")

    return Object.freeze({
      ...this.#config,
      agents: Object.freeze({
        ...agents,
        enabled: false,
      }),
      developer_instructions: [request.system, attachment.developerInstructions]
        .filter(fragment => fragment.length > 0)
        .join("\n"),
      features: Object.freeze({
        ...features,
        multi_agent: false,
        shell_tool: attachment.shellEnabled,
        unified_exec: attachment.shellEnabled,
      }),
      mcp_servers: Object.freeze({
        ...suppliedMcpOverrides,
        ...attachment.mcpServers,
      }),
    })
  }

  /**
   * Narrows a validated optional Codex config section to a table.
   */
  static #configTable(value: CodexConfigValue | undefined, label: string): Readonly<Record<string, CodexConfigValue>> {
    if (value === undefined) {
      return Object.freeze({})
    }

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError(`${label} must be an object`)
    }

    // Array.isArray() narrows mutable arrays but not this recursive readonly
    // union. The runtime checks above establish the config-table branch.
    return value as CodexConfig
  }
}

/**
 * Configures one immutable Codex Agent adapter without performing I/O.
 */
export function codexAgent(options: CodexAgentOptions = {}): CodexAgentProvider {
  const captured = captureOptions(options)

  return defineAgentProvider(new CodexAgentImplementation(captured))
}

/**
 * Validates and snapshots provider configuration at the factory boundary.
 */
function captureOptions(options: CodexAgentOptions): CapturedCodexAgentOptions {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Codex Agent options must be an object")
  }

  // Capture each external property exactly once. Accessor-backed options must
  // not validate one value and substitute another in the immutable provider.
  const apiKeyValue = options.apiKey
  const baseUrlValue = options.baseUrl
  const clientFactoryValue = options.clientFactory
  const codexPathOverrideValue = options.codexPathOverride
  const configValue = options.config
  const envValue = options.env
  const modelValue = options.model
  const reasoningEffort = options.reasoningEffort
  const skipGitRepoCheck = options.skipGitRepoCheck
  const workingDirectoryValue = options.workingDirectory

  const apiKey = optionalSecret(apiKeyValue, "Codex apiKey")
  const baseUrl = optionalNormalizedString(baseUrlValue, "Codex baseUrl")
  const codexPathOverride = optionalNormalizedString(codexPathOverrideValue, "Codex codexPathOverride")
  const model = optionalNormalizedString(modelValue, "Codex model")
  const workingDirectory = optionalNormalizedString(workingDirectoryValue, "Codex workingDirectory")

  if (reasoningEffort !== undefined && !REASONING_EFFORTS.has(reasoningEffort)) {
    throw new TypeError("Codex reasoningEffort is unsupported")
  }

  if (skipGitRepoCheck !== undefined && typeof skipGitRepoCheck !== "boolean") {
    throw new TypeError("Codex skipGitRepoCheck must be a boolean")
  }

  // Only omission selects the credentialed default. An explicit null must
  // fail here rather than unexpectedly changing execution authority.
  const suppliedClientFactory = clientFactoryValue === undefined ? new CodexSdkClientFactory() : clientFactoryValue
  let clientFactoryCreate: unknown

  if (typeof suppliedClientFactory !== "object" || suppliedClientFactory === null) {
    throw new TypeError("Codex clientFactory create must be a function")
  }

  try {
    // Capture the external method once. A stateful getter must not validate as
    // one function and then substitute another when the first Agent runs.
    clientFactoryCreate = Reflect.get(suppliedClientFactory, "create")
  } catch (cause) {
    throw new TypeError("Codex clientFactory create must be readable", { cause })
  }

  if (typeof clientFactoryCreate !== "function") {
    throw new TypeError("Codex clientFactory create must be a function")
  }

  const clientFactory: CodexClientFactory = Object.freeze({
    create(options: CodexClientOptions) {
      return Reflect.apply(clientFactoryCreate as CodexClientFactory["create"], suppliedClientFactory, [
        options,
      ]) as CodexClient
    },
  })
  const config = snapshotConfig(configValue === undefined ? {} : configValue, "config")
  const env = envValue === undefined ? undefined : snapshotEnvironment(envValue)

  // These invocation-owned tables are merged structurally during run().
  // Reject incompatible base values now rather than silently discarding them.
  for (const key of ["agents", "features", "mcp_servers"] as const) {
    const value = config[key]

    if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value))) {
      throw new TypeError(`Codex config ${key} must be an object`)
    }
  }

  return Object.freeze({
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    clientFactory,
    ...(codexPathOverride === undefined ? {} : { codexPathOverride }),
    config,
    ...(env === undefined ? {} : { env }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(skipGitRepoCheck === undefined ? {} : { skipGitRepoCheck }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  })
}

/**
 * Copies a JSON-like Codex config while rejecting cycles and invalid values.
 */
function snapshotConfig(value: CodexConfig, label: string, ancestors = new Set<object>(), depth = 0): CodexConfig {
  if (depth > MAX_CODEX_CONFIG_DEPTH) {
    throw new TypeError(`Codex config exceeds the maximum depth of ${MAX_CODEX_CONFIG_DEPTH}`)
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`Codex ${label} must be a plain object`)
  }

  if (ancestors.has(value)) {
    throw new TypeError(`Codex ${label} cannot contain cycles`)
  }

  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  const entries: Array<readonly [string, CodexConfigValue]> = []

  for (const [key, child] of Object.entries(value)) {
    if (key.length === 0) {
      throw new TypeError(`Codex ${label} keys must be non-empty strings`)
    }

    entries.push([key, snapshotConfigValue(child, `${label}.${key}`, nextAncestors, depth + 1)])
  }

  // Object.fromEntries keeps "__proto__" as authored data rather than
  // invoking the legacy prototype setter on a plain accumulator.
  return Object.freeze(Object.fromEntries(entries))
}

/**
 * Recursively validates one supported Codex config value.
 */
function snapshotConfigValue(
  value: CodexConfigValue,
  label: string,
  ancestors: Set<object>,
  depth: number
): CodexConfigValue {
  if (typeof value === "string" || typeof value === "boolean") {
    return value
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Codex ${label} must be finite`)
    }

    return value
  }

  if (depth > MAX_CODEX_CONFIG_DEPTH) {
    throw new TypeError(`Codex config exceeds the maximum depth of ${MAX_CODEX_CONFIG_DEPTH}`)
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError(`Codex ${label} cannot contain cycles`)
    }

    const nextAncestors = new Set(ancestors)
    nextAncestors.add(value)

    // Array.map skips holes, but the Codex SDK later serializes every position
    // into TOML. Reject sparse input here instead of opening Tool resources
    // before a malformed empty array element fails in the CLI.
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`Codex ${label} cannot contain sparse arrays`)
      }
    }

    return Object.freeze(
      value.map((child, index) => snapshotConfigValue(child, `${label}[${index}]`, nextAncestors, depth + 1))
    )
  }

  // The preceding primitive and array branches leave only a config object;
  // TypeScript does not remove readonly arrays from this recursive union.
  return snapshotConfig(value as CodexConfig, label, ancestors, depth)
}

/**
 * Snapshots an explicit Codex process environment without reading host env.
 */
function snapshotEnvironment(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Codex env must be an object")
  }

  const entries: Array<readonly [string, string]> = []

  for (const [name, entry] of Object.entries(value)) {
    if (name.length === 0 || typeof entry !== "string") {
      throw new TypeError("Codex env must contain non-empty names and string values")
    }

    entries.push([name, entry])
  }

  return Object.freeze(Object.fromEntries(entries))
}

/**
 * Validates provider identifiers and paths without interpreting them.
 */
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
 * Accepts opaque credentials while still rejecting an empty value.
 */
function optionalSecret(value: string | undefined, label: string): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }

  return value
}
