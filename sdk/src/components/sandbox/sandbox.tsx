import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"
import type { SandboxAccess, SandboxProvider } from "./sandbox-provider.js"

/**
 * Portable policy and provider selection for one ephemeral execution scope.
 */
export interface SandboxProps {
  /**
   * Portable filesystem authority requested for this scope.
   *
   * An outer Sandbox defaults to `"read-only"`; a nested Sandbox inherits its
   * parent when omitted. Nested scopes may narrow read-write to read-only but
   * cannot widen read-only access.
   */
  readonly access?: SandboxAccess

  /**
   * AML values evaluated while the effective Sandbox session is active.
   *
   * Omission evaluates an empty scope and still acquires and releases an outer
   * lease.
   */
  readonly children?: AmlRenderable

  /**
   * Portable logical working directory exposed to descendants.
   *
   * For an outer Sandbox, an explicit `root` is also the default cwd. When both
   * props are omitted, cwd defaults to the enclosing Workspace cwd and then
   * `"."`. In a nested Sandbox it resolves within the nested root and otherwise
   * inherits the parent cwd.
   */
  readonly cwd?: string

  /**
   * Provider used to acquire an outer Sandbox lease.
   *
   * When omitted, AML uses `AmlRuntimeOptions.sandboxProvider`. Nested Sandboxes
   * always reuse the parent lease and therefore cannot set this prop.
   */
  readonly provider?: SandboxProvider

  /**
   * Portable logical root visible to this scope and its descendants.
   *
   * An outer Sandbox defaults to `"."`. A nested value resolves beneath and
   * narrows the parent root; it cannot escape that root.
   */
  readonly root?: string
}

/**
 * Scopes one provider-owned execution lease to its descendants.
 *
 * The outermost Sandbox acquires and releases the provider resource even when a
 * descendant fails. Nested Sandboxes create restrictive logical views of the
 * active lease and never acquire another resource. Script execution and
 * compatible Agents receive the effective session; native permission flags
 * cannot widen its policy.
 */
export function Sandbox(_props: SandboxProps): never {
  throw new Error("<Sandbox> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Sandbox, "sandbox")
