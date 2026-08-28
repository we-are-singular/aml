/**
 * Provider-neutral final result for one Agent session.
 */
export interface AgentResponse {
  /**
   * Assistant messages in first-seen order when every text chunk was bounded.
   *
   * The last item is the final assistant message for the completed turn.
   * Providers without message identities, or whose profile transforms the
   * assembled text, retain only the concatenated `text`.
   */
  readonly messages?: readonly string[]

  /**
   * Provider-native structured value when the request declared JSON output.
   */
  readonly structured?: unknown
  readonly text: string
}
