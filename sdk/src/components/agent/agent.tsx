import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"
import type { AmlModelSchema } from "./aml-model-schema.js"
import type { AgentProvider } from "./agent-provider.js"

/**
 * Native coding capabilities requested from an Agent harness.
 *
 * These settings configure the harness; an enclosing Sandbox remains the
 * authoritative confinement boundary.
 */
export interface AgentPermissions {
  /**
   * Filesystem authority requested from the native Agent harness.
   *
   * Defaults to `"read-write"`. A read-only enclosing Sandbox always narrows
   * this value to `"read-only"`; this setting cannot widen Sandbox access.
   */
  readonly filesystem: "read-only" | "read-write"

  /**
   * Whether the native Agent harness may use network capabilities.
   *
   * Defaults to `true`. Provider support and Sandbox or deployment network
   * policy remain authoritative.
   */
  readonly network: boolean

  /**
   * Whether the native Agent harness may execute shell commands.
   *
   * Defaults to `true`. This is a provider control, not an isolation boundary;
   * use an enforcing Sandbox when command execution needs confinement.
   */
  readonly shell: boolean
}

/**
 * Optional overrides for AML's optimistic native-capability defaults.
 *
 * Omitted fields retain the defaults described by {@link AgentPermissions}.
 */
export type AgentPermissionOverrides = Partial<AgentPermissions>

/**
 * Provider selection, prompt children, and optional Agent-level overrides.
 */
export interface AgentProps {
  /**
   * Initial prompt content and Agent-scoped descriptors.
   *
   * AML resolves nested values before opening the provider session. Ordinary
   * text forms the initial prompt; `System`, `Skill`, `Tool`, `Mcp`, and
   * `FollowUp` children contribute to their dedicated parts of the request.
   * Omission produces an empty initial prompt.
   */
  readonly children?: AmlRenderable

  /**
   * Agent-local logical working directory within an enclosing Sandbox.
   *
   * The value is a portable relative path resolved from the active Sandbox
   * root. It defaults to the Sandbox cwd and is invalid without a Sandbox.
   */
  readonly cwd?: string

  /**
   * Provider-owned model identifier for this session.
   *
   * AML passes the value through unchanged. When omitted, the selected Agent
   * provider chooses its configured or native default model.
   */
  readonly model?: string

  /**
   * Non-empty normalized diagnostic label for this Agent occurrence.
   *
   * Names need not be unique and appear only in traces and error messages;
   * AML never adds them to model prompts. Omission leaves the Agent unnamed.
   */
  readonly name?: string

  /**
   * Native harness capability overrides for this session.
   *
   * Omitted fields default to read-write filesystem, network, and shell access.
   * Sandbox policy may narrow the effective filesystem authority.
   */
  readonly permissions?: AgentPermissionOverrides

  /**
   * Agent provider that owns this session's model and harness lifecycle.
   *
   * When omitted, AML uses `AmlRuntimeOptions.agentProvider`. Evaluation fails
   * if neither location supplies a provider.
   */
  readonly provider?: AgentProvider

  /**
   * Standard Schema used to request and validate structured final output.
   *
   * The validated value is rendered as canonical JSON text in ordinary AML
   * composition. Use component-local `evaluate(value, schema)` instead when
   * application code needs the schema-inferred value directly.
   */
  readonly schema?: AmlModelSchema<unknown, unknown>

  /**
   * Fixed system text for this Agent.
   *
   * It follows runtime-wide system text and precedes child `System` fragments.
   * Empty or omitted text contributes no system fragment.
   */
  readonly system?: string

  /**
   * Maximum provider-session duration in milliseconds.
   *
   * A supplied value must be a positive safe integer. The timer starts after
   * the Agent obtains a scheduler slot; expiry aborts the provider session and
   * AML still awaits provider cleanup. Omission applies no Agent-local timeout.
   */
  readonly timeoutMs?: number
}

/**
 * Declares one provider-backed Agent session and contributes its final text.
 *
 * AML resolves prompt fragments and capability descriptors before opening the
 * session, runs the initial turn and ordered follow-ups in one provider-owned
 * history, then awaits cleanup before the component settles. Direct invocation
 * is invalid; `AmlRuntime` evaluates the JSX descriptor.
 */
export function Agent(_props: AgentProps): never {
  throw new Error("<Agent> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Agent, "agent")
