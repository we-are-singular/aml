import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"

/**
 * Text file materialized inside the active Workspace.
 */
export interface FileProps {
  /**
   * AML content resolved to the UTF-8 file body.
   *
   * The prop is required, though it may resolve to an empty string. The write
   * contributes no text to the surrounding AML result.
   */
  readonly children: AmlRenderable

  /**
   * Portable relative destination beneath the active Workspace materialization.
   *
   * The path must identify a file, cannot escape the Workspace root, and cannot
   * traverse a symlink or replace a directory.
   */
  readonly path: string
}

/**
 * Atomically writes resolved child text into the active host Workspace.
 *
 * Parent directories are created safely and an existing regular file may be
 * replaced. The component requires an enclosing `Workspace`, is invalid inside
 * a `Sandbox`, and leaves durable publication to the Workspace save policy.
 */
export function File(_props: FileProps): never {
  throw new Error("<File> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(File, "file")
