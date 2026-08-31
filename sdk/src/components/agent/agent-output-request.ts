import type { AmlJsonValue } from "../../core/aml-json-value.js"

/**
 * Portable structured-output declaration supplied to an Agent provider.
 */
export interface AgentOutputRequest {
  /**
   * Read-only JSON Schema shown to the model-facing provider integration.
   *
   * AML retains the authoritative Standard Schema validator separately and
   * validates the provider's returned `structured` value at the SDK boundary.
   */
  readonly jsonSchema: Readonly<Record<string, AmlJsonValue>>

  /** Discriminant for AML's portable JSON structured-output request. */
  readonly type: "json"
}
