import { AmlNode } from "../../core/aml-node.js"

/** Rendering controls shared by both supported Include source modes. */
interface IncludeSharedProps {
  /** Optional positive byte ceiling for prompt inlining. */
  readonly maxBytes?: number

  /** Markdown heading text, or `false` to emit only the body. */
  readonly title?: string | false
}

/** File content included from exactly one application or active-filesystem path. */
export type IncludeProps = IncludeSharedProps &
  (
    | {
        /** Active Workspace or Sandbox file read live during evaluation. */
        readonly path: string
        /** Application source is unavailable when active `path` owns the read. */
        readonly src?: never
      }
    | {
        /** Active path is unavailable when application `src` owns the read. */
        readonly path?: never
        /** Application-owned local file resolved from `AmlRuntime.cwd`. */
        readonly src: string
      }
  )

/**
 * Adds live file content or a bounded Agent-visible read instruction.
 *
 * Local `src` and active-filesystem `path` are mutually exclusive. This
 * primitive is runtime-owned because size checks and staging must complete
 * before the containing Agent session starts.
 */
export function Include(_props: IncludeProps): never {
  throw new Error("<Include> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Include, "include")
