import type { AgentExecutionContext, AgentRequest, AgentResponse } from "@aml-jsx/sdk"

import type { CodexClient, CodexReasoningEffort, CodexThread, CodexThreadOptions } from "./codex-client-factory.js"
import { prepareCodexOutputSchema } from "./prepare-codex-output-schema.js"

interface CodexSessionOptions {
  readonly model?: string
  readonly reasoningEffort?: CodexReasoningEffort
  readonly skipGitRepoCheck?: boolean
  readonly workingDirectory?: string
}

/**
 * Owns one validated authored turn plan and its fresh Codex thread.
 */
export class CodexSession {
  readonly #model: string | undefined
  readonly #outputSchema: Readonly<Record<string, unknown>> | undefined
  readonly #prompts: readonly string[]
  readonly #reasoningEffort: CodexReasoningEffort | undefined
  readonly #skipGitRepoCheck: boolean | undefined
  readonly #workingDirectory: string | undefined

  /**
   * Validates every turn before capability setup can perform external work.
   */
  constructor(request: AgentRequest, options: CodexSessionOptions) {
    this.#model = CodexSession.#validateModel(request.model ?? options.model)
    this.#outputSchema = request.output === undefined ? undefined : prepareCodexOutputSchema(request.output.jsonSchema)
    this.#reasoningEffort = options.reasoningEffort
    this.#skipGitRepoCheck = options.skipGitRepoCheck
    this.#workingDirectory = options.workingDirectory

    if (request.followUps !== undefined && !Array.isArray(request.followUps)) {
      throw new TypeError("Codex followUps must be an array")
    }

    const prompts = [request.prompt]

    for (const followUp of request.followUps ?? []) {
      if (typeof followUp !== "string" || followUp.length === 0) {
        throw new TypeError("Codex followUps must contain non-empty strings")
      }

      prompts.push(followUp)
    }

    this.#prompts = Object.freeze(prompts)
  }

  /**
   * Executes every authored input through one provider conversation.
   */
  async run(client: CodexClient, context: AgentExecutionContext): Promise<AgentResponse> {
    context.signal.throwIfAborted()

    const startThread = client.startThread

    if (typeof startThread !== "function") {
      throw new TypeError("Codex client startThread must be a function")
    }

    const threadOptions: CodexThreadOptions = Object.freeze({
      approvalPolicy: "never",
      ...(this.#model === undefined ? {} : { model: this.#model }),
      ...(this.#reasoningEffort === undefined
        ? {}
        : {
            modelReasoningEffort: this.#reasoningEffort,
          }),
      networkAccessEnabled: false,
      sandboxMode: "read-only",
      ...(this.#skipGitRepoCheck === undefined ? {} : { skipGitRepoCheck: this.#skipGitRepoCheck }),
      webSearchMode: "disabled",
      ...(this.#workingDirectory === undefined ? {} : { workingDirectory: this.#workingDirectory }),
    })
    const thread = Reflect.apply(startThread, client, [threadOptions]) as CodexThread

    if (typeof thread !== "object" || thread === null) {
      throw new TypeError("Codex client must return a thread object")
    }

    const run = thread.run

    if (typeof run !== "function") {
      throw new TypeError("Codex thread run must be a function")
    }

    let finalResponse = ""

    for (const [index, prompt] of this.#prompts.entries()) {
      // A cancellation between FollowUps must not admit another authored input
      // into the retained Codex conversation.
      context.signal.throwIfAborted()
      const isFinalTurn = index === this.#prompts.length - 1
      const turn = await Reflect.apply(run, thread, [
        prompt,
        Object.freeze({
          ...(isFinalTurn && this.#outputSchema !== undefined ? { outputSchema: this.#outputSchema } : {}),
          signal: context.signal,
        }),
      ])
      context.signal.throwIfAborted()

      let responseValue: unknown

      // The injected client is an external boundary. Read its result field once
      // so a stateful getter cannot change the turn after validation.
      try {
        responseValue = typeof turn === "object" && turn !== null ? Reflect.get(turn, "finalResponse") : undefined
      } catch (cause) {
        throw new TypeError("Codex thread returned an invalid turn result", { cause })
      }

      if (typeof turn !== "object" || turn === null || typeof responseValue !== "string") {
        throw new TypeError("Codex thread returned an invalid turn result")
      }

      // Reading an injected result can execute an accessor. Re-check after the
      // one trusted-boundary read so cancellation cannot become a success.
      context.signal.throwIfAborted()
      finalResponse = responseValue
    }

    if (this.#outputSchema === undefined) {
      return Object.freeze({ text: finalResponse })
    }

    let structured: unknown

    try {
      structured = JSON.parse(finalResponse)
    } catch (cause) {
      throw new TypeError("Codex structured response is not valid JSON", { cause })
    }

    context.signal.throwIfAborted()
    return Object.freeze({
      structured,
      text: finalResponse,
    })
  }

  /**
   * Accepts an opaque Codex model name without normalizing its identity.
   */
  static #validateModel(value: string | undefined): string | undefined {
    if (value === undefined) {
      return undefined
    }

    if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
      throw new TypeError("Codex model must be a non-empty normalized string")
    }

    return value
  }
}
