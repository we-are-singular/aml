import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"

import type { AmlJsonValue } from "../../core/aml-json-value.js"
import type { AmlTraceIdentity } from "../../core/trace-identity.js"

const AML_TOOL_REGISTRY = Symbol.for("@aml-jsx/sdk/tool-registry")

interface AmlToolGlobal {
  [AML_TOOL_REGISTRY]?: WeakMap<object, AgentJavaScriptTool>
}

/**
 * Input schema contract required by defineTool().
 *
 * Standard Schema validates provider input while Standard JSON Schema produces
 * the model-facing declaration from the same source of truth.
 */
export type AmlToolSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output> &
  StandardJSONSchemaV1<Input, Output>

/**
 * Invocation-scoped information supplied to a JavaScript Tool.
 */
export interface AgentToolExecutionContext {
  /** Evaluation signal that application Tool work must honor cooperatively. */
  readonly signal: AbortSignal

  /** Trace identity of the Tool call inside its containing Agent turn. */
  readonly trace: AmlTraceIdentity
}

/**
 * Provider-facing JavaScript capability after AML has captured its contract.
 */
export interface AgentJavaScriptTool {
  /** Non-empty model-facing explanation of what the capability does. */
  readonly description: string

  /**
   * Executes the capability with provider-supplied input and evaluation context.
   *
   * AML validates input before application code runs and returns a stable
   * JSON-compatible snapshot. Providers and conformance tests use this low-level
   * method; application components normally call the `AmlTool` function.
   */
  execute(input: unknown, context: AgentToolExecutionContext): Promise<AmlJsonValue>

  /** Immutable JSON Schema advertised to the model for Tool-call arguments. */
  readonly inputSchema: Readonly<Record<string, unknown>>

  /** Provider-facing capability discriminant. */
  readonly kind: "javascript"

  /** Non-empty normalized model-facing Tool name. */
  readonly name: string
}

/**
 * Complete provider-neutral JavaScript capability for one Agent request.
 */
export type AgentTool = AgentJavaScriptTool

/**
 * A JavaScript Tool created by defineTool().
 *
 * The non-enumerable field discourages accidental structural implementations
 * while remaining compatible across physical SDK copies. Runtime authenticity
 * comes from an exact-identity registry, never from this readable shape.
 */
export interface AmlTool<Input = never, Output = AmlJsonValue> extends AgentJavaScriptTool {
  /**
   * Invokes this Tool through the active AML function component.
   *
   * Calls inherit the component's cancellation, trace, and resource lifetime.
   * Calling outside an active component fails; calling does not grant the Tool
   * to any Agent.
   */
  (input: Input): Promise<Output>

  /**
   * Non-enumerable authoring marker present on `defineTool` results.
   *
   * Runtime authenticity uses exact registered identity rather than trusting
   * this structurally reproducible field.
   */
  readonly __amlTool: true
}

/**
 * Registers one exact defineTool() result with its SDK-owned execution port.
 *
 * The global WeakMap is intentional: separately installed SDK copies in one
 * JavaScript realm must recognize each other's definitions without accepting
 * clones, derived objects, or forwarding proxies.
 */
export function registerAmlTool(tool: AmlTool<never, unknown>, execution: AgentJavaScriptTool): void {
  toolRegistry().set(tool, execution)
}

/**
 * Returns the SDK-owned execution port only for an exact registered identity.
 */
export function registeredAmlTool(value: unknown): AgentJavaScriptTool | undefined {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? toolRegistry().get(value)
    : undefined
}

/**
 * Creates or recovers the cross-package exact-identity registry for this realm.
 */
function toolRegistry(): WeakMap<object, AgentJavaScriptTool> {
  const amlGlobal = globalThis as typeof globalThis & AmlToolGlobal
  const existing = amlGlobal[AML_TOOL_REGISTRY]

  if (existing !== undefined) {
    if (!(existing instanceof WeakMap)) {
      throw new TypeError("AML Tool registry has an invalid global value")
    }

    return existing
  }

  const created = new WeakMap<object, AgentJavaScriptTool>()

  Object.defineProperty(amlGlobal, AML_TOOL_REGISTRY, {
    configurable: false,
    enumerable: false,
    value: created,
    writable: false,
  })

  return created
}
