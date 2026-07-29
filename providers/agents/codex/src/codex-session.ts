import {
  type AgentExecutionContext,
  type AgentProviderSession,
  type AgentProviderTurn,
  type AgentRequest,
} from "@aml-jsx/sdk"
import { defu } from "defu"

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
  readonly #reasoningEffort: CodexReasoningEffort | undefined
  readonly #skipGitRepoCheck: boolean | undefined
  readonly #workingDirectory: string | undefined

  /**
   * Validates every turn before capability setup can perform external work.
   */
  constructor(request: AgentRequest, options: CodexSessionOptions) {
    const resolved = defu(
      request.model === undefined ? {} : { model: request.model },
      options.model === undefined ? {} : { model: options.model }
    )

    this.#model = CodexSession.#validateModel(resolved.model)
    this.#outputSchema = request.output === undefined ? undefined : prepareCodexOutputSchema(request.output.jsonSchema)
    this.#reasoningEffort = options.reasoningEffort
    this.#skipGitRepoCheck = options.skipGitRepoCheck
    this.#workingDirectory = options.workingDirectory
  }

  /**
   * Starts one Codex thread and exposes its provider-neutral turn surface.
   */
  open(client: CodexClient): AgentProviderSession {
    const startThread = client.startThread

    if (typeof startThread !== "function") {
      throw new TypeError("Codex client startThread must be a function")
    }

    const userInputs = {
      ...(this.#model === undefined ? {} : { model: this.#model }),
      ...(this.#reasoningEffort === undefined
        ? {}
        : {
            modelReasoningEffort: this.#reasoningEffort,
          }),
      ...(this.#skipGitRepoCheck === undefined ? {} : { skipGitRepoCheck: this.#skipGitRepoCheck }),
      ...(this.#workingDirectory === undefined ? {} : { workingDirectory: this.#workingDirectory }),
    }
    const imperativeConfig = {
      approvalPolicy: "never",
      networkAccessEnabled: false,
      sandboxMode: "read-only",
      webSearchMode: "disabled",
    } as const
    const threadOptions = Object.freeze(defu(imperativeConfig, userInputs)) as CodexThreadOptions
    const thread = Reflect.apply(startThread, client, [threadOptions]) as CodexThread

    if (typeof thread !== "object" || thread === null) {
      throw new TypeError("Codex client must return a thread object")
    }

    const run = thread.run

    if (typeof run !== "function") {
      throw new TypeError("Codex thread run must be a function")
    }

    return {
      async close() {},
      runTurn: async (turn: Readonly<AgentProviderTurn>, context: AgentExecutionContext) => {
        const result = await Reflect.apply(run, thread, [
          turn.prompt,
          Object.freeze({
            ...(turn.output !== undefined && this.#outputSchema !== undefined
              ? { outputSchema: this.#outputSchema }
              : {}),
            signal: context.signal,
          }),
        ])
        context.signal.throwIfAborted()

        let responseValue: unknown

        // The injected client is an external boundary. Read its result field once
        // so a stateful getter cannot change the turn after validation.
        try {
          responseValue =
            typeof result === "object" && result !== null ? Reflect.get(result, "finalResponse") : undefined
        } catch (cause) {
          throw new TypeError("Codex thread returned an invalid turn result", { cause })
        }

        if (typeof result !== "object" || result === null || typeof responseValue !== "string") {
          throw new TypeError("Codex thread returned an invalid turn result")
        }

        // Reading an injected result can execute an accessor. Re-check after the
        // one trusted-boundary read so cancellation cannot become a success.
        context.signal.throwIfAborted()

        if (turn.output === undefined) {
          return Object.freeze({ text: responseValue })
        }

        let structured: unknown

        try {
          structured = JSON.parse(responseValue)
        } catch (cause) {
          throw new TypeError("Codex structured response is not valid JSON", { cause })
        }

        return Object.freeze({
          structured,
          text: responseValue,
        })
      },
    }
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
