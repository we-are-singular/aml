import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"

/**
 * Text file materialized inside the active Workspace.
 */
export interface FileProps {
  readonly children: AmlRenderable
  readonly path: string
}

/**
 * Writes resolved child text without adding it to the surrounding prompt.
 */
export function File(_props: FileProps): never {
  throw new Error("<File> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(File, "file")
