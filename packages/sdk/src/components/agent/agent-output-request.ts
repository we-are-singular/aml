import type { AmlJsonValue } from "../../core/aml-json-value.js"

/**
 * Portable structured-output declaration supplied to an Agent provider.
 */
export interface AgentOutputRequest {
  readonly jsonSchema: Readonly<Record<string, AmlJsonValue>>
  readonly type: "json"
}
