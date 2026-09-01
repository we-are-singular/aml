import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"

/** Destination shared by both supported File source modes. */
interface FileSharedProps {
  /** Portable relative destination beneath the nearest active filesystem. */
  readonly path: string
}

/** Text materialized from exactly one local source or resolved AML subtree. */
export type FileProps = FileSharedProps &
  (
    | {
        /** AML content resolved to the UTF-8 file body. */
        readonly children: AmlRenderable
        /** Local source is unavailable when resolved children own the body. */
        readonly src?: never
      }
    | {
        /** Resolved children are unavailable when a local source owns the body. */
        readonly children?: never
        /** Application-owned UTF-8 file resolved from `AmlRuntime.cwd`. */
        readonly src: string
      }
  )

/**
 * Replaces one file through the nearest Sandbox or Workspace filesystem.
 *
 * The write contributes no prompt text. Lexical placement chooses the owner;
 * inside Sandbox the live guest wins over any host Workspace replica.
 */
export function File(_props: FileProps): never {
  throw new Error("<File> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(File, "file")
