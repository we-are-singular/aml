import type {
  AgentExecutionContext,
  AgentMcpServer,
  AgentTool,
} from "@aml/sdk"

/**
 * OpenCode's provider/model identity split.
 */
export interface OpenCodeModel {
  readonly modelId: string
  readonly providerId: string
}

/**
 * Address of one created OpenCode session.
 */
export interface OpenCodeSessionLocation {
  readonly directory?: string
  readonly sessionId: string
}

/**
 * Provider-owned fields used to create a fresh OpenCode session.
 */
export interface OpenCodeSessionCreateInput {
  readonly directory?: string
  readonly model?: OpenCodeModel
  readonly title: string
}

/**
 * Complete initial prompt and capability map for one OpenCode session.
 */
export interface OpenCodeSessionPromptInput extends OpenCodeSessionLocation {
  readonly model?: OpenCodeModel
  readonly prompt: string
  readonly system: string
  readonly tools: Readonly<Record<string, boolean>>
}

/**
 * Minimal response-part shape consumed by the AML adapter.
 */
export interface OpenCodeSessionPart {
  readonly ignored?: unknown
  readonly synthetic?: unknown
  readonly text?: unknown
  readonly type: string
}

/**
 * Provider response retained until visible text is validated and selected.
 */
export interface OpenCodeSessionPromptResult {
  readonly error?: unknown
  readonly parts: readonly OpenCodeSessionPart[]
}

/**
 * Invocation-scoped capability map and its idempotent cleanup boundary.
 */
export interface OpenCodeCapabilityAttachment {
  readonly tools: Readonly<Record<string, boolean>>

  /**
   * Idempotently detaches provider capabilities and invocation-owned resources.
   */
  close(): Promise<void>
}

/**
 * Inputs needed to preflight and attach capabilities before session creation.
 */
export interface OpenCodeCapabilityAttachmentInput {
  readonly context: AgentExecutionContext
  readonly directory?: string
  readonly mcpServers: readonly AgentMcpServer[]
  readonly tools: readonly AgentTool[]
}

/**
 * Narrow provider-owned port used by AML session orchestration.
 *
 * It deliberately excludes OpenCode SDK types so deterministic tests and
 * third-party client bridges do not depend on the generated transport surface.
 */
export interface OpenCodeSessionClient {
  /**
   * Requests cancellation for an already-created session.
   */
  abort(input: OpenCodeSessionLocation): Promise<void>

  /**
   * Preflights and attaches all Agent capabilities before session creation.
   */
  attachCapabilities(
    input: OpenCodeCapabilityAttachmentInput,
    signal: AbortSignal,
  ): Promise<OpenCodeCapabilityAttachment>

  /**
   * Opens one fresh provider session and returns its acknowledged identity.
   */
  create(
    input: OpenCodeSessionCreateInput,
    signal: AbortSignal,
  ): Promise<string>

  /**
   * Deletes provider state after execution and capability cleanup.
   */
  delete(input: OpenCodeSessionLocation): Promise<void>

  /**
   * Sends the complete initial Agent request into the created session.
   */
  prompt(
    input: OpenCodeSessionPromptInput,
    signal: AbortSignal,
  ): Promise<OpenCodeSessionPromptResult>
}
