/**
 * Provider-neutral final result for one Agent session.
 */
export interface AgentResponse {
  /**
   * Provider-native structured value when the request declared JSON output.
   */
  readonly structured?: unknown
  readonly text: string
}
