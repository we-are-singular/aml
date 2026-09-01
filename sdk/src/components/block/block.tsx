import type { AmlRenderable } from "../../core/aml-node.js"

/** Exact blank-line separation around optional authored AML content. */
export interface BlockProps {
  /** Content preserved between two leading and two trailing newline characters. */
  readonly children?: AmlRenderable
}

/**
 * Adds deliberate Markdown block separation without creating a runtime scope.
 *
 * An empty Block is one `"\n\n"` separator. A Block with children returns the
 * transparent sequence `"\n\n"`, children, `"\n\n"` so descriptors retain
 * their existing nearest Agent or resource owner.
 */
export function Block({ children }: BlockProps): AmlRenderable {
  return children === undefined ? "\n\n" : ["\n\n", children, "\n\n"]
}
