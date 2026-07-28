/**
 * Recursive configuration accepted by the Codex SDK's `--config` bridge.
 */
export type CodexConfigValue = boolean | number | string | readonly CodexConfigValue[] | CodexConfig

/**
 * Provider-specific Codex configuration captured without importing SDK types.
 */
export interface CodexConfig {
  readonly [key: string]: CodexConfigValue
}

/**
 * Codex reasoning levels exposed through the configured provider factory.
 */
export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh"

/**
 * SDK-construction values that vary for each AML Agent invocation.
 */
export interface CodexClientOptions {
  readonly apiKey?: string
  readonly baseUrl?: string
  readonly codexPathOverride?: string
  readonly config: CodexConfig
  readonly env?: Readonly<Record<string, string>>
}

/**
 * Safety and model options fixed for one fresh Codex thread.
 */
export interface CodexThreadOptions {
  readonly approvalPolicy: "never"
  readonly model?: string
  readonly modelReasoningEffort?: CodexReasoningEffort
  readonly networkAccessEnabled: false
  readonly sandboxMode: "read-only"
  readonly skipGitRepoCheck?: boolean
  readonly webSearchMode: "disabled"
  readonly workingDirectory?: string
}

/**
 * Per-turn controls passed to the Codex SDK.
 */
export interface CodexTurnOptions {
  readonly outputSchema?: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
}

/**
 * Minimal completed-turn shape consumed by the AML adapter.
 *
 * The concrete SDK also returns items and usage. They remain provider-owned
 * data until the observability boundary translates them into AML trace events.
 */
export interface CodexTurnResult {
  readonly finalResponse: string
}

/**
 * One provider session that can receive sequential authored turns.
 */
export interface CodexThread {
  /**
   * Executes one turn and resolves only after the Codex CLI process settles.
   */
  run(prompt: string, options: CodexTurnOptions): Promise<CodexTurnResult>
}

/**
 * One invocation-configured Codex SDK client.
 */
export interface CodexClient {
  /**
   * Creates a fresh thread with the complete AML safety policy.
   */
  startThread(options: CodexThreadOptions): CodexThread
}

/**
 * Narrow dependency-injection port for constructing the Codex SDK lazily.
 */
export interface CodexClientFactory {
  /**
   * Creates the SDK client after invocation-specific capabilities are known.
   */
  create(options: CodexClientOptions): CodexClient
}
