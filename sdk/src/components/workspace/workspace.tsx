import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"
import type { WorkspaceProvider } from "./workspace-provider.js"

export interface WorkspaceLoadOptions {
  readonly exclude?: readonly string[]
  readonly include?: readonly string[]
  readonly revision?: "current" | string
}

export interface WorkspaceSaveOptions {
  readonly exclude?: readonly string[]
  readonly gitignore?: boolean
  readonly include?: readonly string[]
  readonly on?: "always" | "success"

  /**
   * Total revisions retained, including the newly published current revision.
   */
  readonly retention?: number
}

/**
 * Filesystem isolation, optional durable state, and authored Workspace subtree.
 */
export interface WorkspaceProps {
  readonly children?: AmlRenderable
  readonly cwd?: string
  readonly id?: string
  readonly load?: boolean | WorkspaceLoadOptions
  readonly lock?: boolean
  readonly provider?: WorkspaceProvider
  readonly save?: boolean | WorkspaceSaveOptions
  readonly writeConcurrency?: "parallel" | "serial"
}

/**
 * Scopes one materialization to its descendant work.
 */
export function Workspace(_props: WorkspaceProps): never {
  throw new Error("<Workspace> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Workspace, "workspace")
