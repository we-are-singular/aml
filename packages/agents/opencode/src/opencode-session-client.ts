export interface OpenCodeModel {
  readonly modelId: string
  readonly providerId: string
}

export interface OpenCodeSessionLocation {
  readonly directory?: string
  readonly sessionId: string
}

export interface OpenCodeSessionCreateInput {
  readonly directory?: string
  readonly model?: OpenCodeModel
  readonly title: string
}

export interface OpenCodeSessionPromptInput extends OpenCodeSessionLocation {
  readonly model?: OpenCodeModel
  readonly prompt: string
  readonly system: string
  readonly tools: Readonly<Record<string, boolean>>
}

export interface OpenCodeSessionPart {
  readonly ignored?: unknown
  readonly synthetic?: unknown
  readonly text?: unknown
  readonly type: string
}

export interface OpenCodeSessionPromptResult {
  readonly error?: unknown
  readonly parts: readonly OpenCodeSessionPart[]
}

/**
 * Narrow provider-owned port used by AML session orchestration.
 *
 * It deliberately excludes OpenCode SDK types so deterministic tests and
 * third-party client bridges do not depend on the generated transport surface.
 */
export interface OpenCodeSessionClient {
  abort(input: OpenCodeSessionLocation): Promise<void>
  create(
    input: OpenCodeSessionCreateInput,
    signal: AbortSignal,
  ): Promise<string>
  delete(input: OpenCodeSessionLocation): Promise<void>
  prompt(
    input: OpenCodeSessionPromptInput,
    signal: AbortSignal,
  ): Promise<OpenCodeSessionPromptResult>
}
