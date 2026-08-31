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
   *
   * AML rejects omission for a structured request and validates this value with
   * the application-owned schema before exposing it to composition.
   */
  readonly structured?: unknown

  /**
   * Concatenated assistant text for the completed turn.
   *
   * This field is required even when the provider also returns `structured` or
   * `messages`; an empty string is a valid text result.
   */
  readonly text: string
}
