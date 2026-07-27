import type { OpenCodeToolAttachment as OpenCodeToolAttachmentContract } from "./opencode-session-client.js"

/**
 * Owns one invocation's OpenCode capability map and cleanup barrier.
 */
export class OpenCodeToolAttachment
  implements OpenCodeToolAttachmentContract
{
  readonly #cleanup: () => Promise<void>
  #closePromise: Promise<void> | undefined
  readonly tools: Readonly<Record<string, boolean>>

  /**
   * Captures the exact OpenCode capability map and its cleanup operation.
   */
  constructor(
    tools: Readonly<Record<string, boolean>>,
    cleanup: () => Promise<void>,
  ) {
    this.tools = Object.freeze({ ...tools })
    this.#cleanup = cleanup
  }

  /**
   * Returns one shared cleanup barrier and never repeats provider teardown.
   */
  close(): Promise<void> {
    this.#closePromise ??= this.#cleanup()
    return this.#closePromise
  }
}
