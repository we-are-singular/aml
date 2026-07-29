import type { AgentToolExecutionContext, SandboxRuntime } from "@aml-jsx/sdk"
import type { ProviderConfig } from "@earendil-works/pi-coding-agent"

/**
 * Reasoning levels understood by Pi's coding-agent runtime.
 */
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

/**
 * One AML JavaScript Tool translated into Pi's session boundary.
 */
export interface PiJavaScriptTool {
  readonly description: string
  execute(input: unknown, context: AgentToolExecutionContext): Promise<unknown>
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly name: string
}

/**
 * Immutable values used to create one fresh Pi session.
 */
export interface PiSessionCreateInput {
  readonly cwd: string
  readonly model?: string
  readonly providers?: Readonly<Record<string, ProviderConfig>>
  readonly sandbox?: Readonly<{
    readonly cwd: string
    readonly runtime: Readonly<SandboxRuntime>
  }>
  readonly system: string
  readonly thinkingLevel?: PiThinkingLevel
  readonly tools: readonly (PiJavaScriptTool | string)[]
  readonly trace: AgentToolExecutionContext["trace"]
}

/**
 * Minimal session surface consumed by AML orchestration.
 */
export interface PiSessionClient {
  abort(): Promise<void>
  dispose(): void
  prompt(prompt: string, outputSchema?: Readonly<Record<string, unknown>>): Promise<string>
}

/**
 * Dependency-injection boundary around Pi's concrete SDK.
 */
export interface PiSessionClientFactory {
  create(input: PiSessionCreateInput, signal: AbortSignal): Promise<PiSessionClient>
}
