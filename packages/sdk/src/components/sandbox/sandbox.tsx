import {
  AmlNode,
  type AmlRenderable,
} from "../../core/aml-node.js"
import type {
  SandboxAccess,
  SandboxProvider,
} from "./sandbox-provider.js"

/**
 * Portable policy and provider selection for one ephemeral execution scope.
 */
export interface SandboxProps {
  readonly access?: SandboxAccess
  readonly children?: AmlRenderable
  readonly cwd?: string
  readonly provider?: SandboxProvider
  readonly root?: string
}

/**
 * Scopes one provider-owned execution lease to its descendants.
 *
 * Nested Sandboxes restrict the active lease; they never acquire another one.
 */
export function Sandbox(_props: SandboxProps): never {
  throw new Error("<Sandbox> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Sandbox, "sandbox")
