/**
 * Formats authored Agent metadata without replacing its provider or trace identity.
 */
export function agentDiagnosticIdentity(input: {
  readonly name: string | undefined
  readonly provider?: string
  readonly spanId: string
}): string {
  if (input.provider === undefined && input.name === undefined) {
    return `Agent ${input.spanId}`
  }

  const provider = input.provider === undefined ? "Agent" : `Agent "${input.provider}"`
  const name = input.name === undefined ? "" : ` [name: "${input.name}"]`

  return `${provider}${name} (${input.spanId})`
}
