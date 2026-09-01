import type { AmlRenderable } from "../../core/aml-node.js"

/** Exact blank-line separation and optional named prompt section. */
export interface BlockProps {
  /** Content preserved between two leading and two trailing newline characters. */
  readonly children?: AmlRenderable

  /**
   * Optional model-facing XML-style section name.
   *
   * AML normalizes the value to lowercase ASCII kebab-case and neutralizes tag
   * syntax. A value with no remaining letters or digits leaves the Block
   * untagged. The wrapper changes prompt text only; it creates no runtime scope.
   */
  readonly tag?: string
}

/**
 * Adds deliberate Markdown block separation without creating a runtime scope.
 *
 * An empty Block is one `"\n\n"` separator. A Block with children returns the
 * transparent sequence `"\n\n"`, children, `"\n\n"` so descriptors retain
 * their existing nearest Agent or resource owner. When `tag` is present, the
 * children are additionally wrapped in one kebab-cased XML-style section.
 */
export function Block({ children, tag }: BlockProps): AmlRenderable {
  if (children === undefined) return "\n\n"

  const sectionTag = tag === undefined ? undefined : normalizeBlockTag(tag)
  if (sectionTag === undefined || sectionTag.length === 0) {
    return ["\n\n", children, "\n\n"]
  }

  return ["\n\n", `<${sectionTag}>\n`, children, `\n</${sectionTag}>`, "\n\n"]
}

function normalizeBlockTag(tag: string): string {
  return tag
    .replaceAll("<", "(")
    .replaceAll("/", "|")
    .trim()
    .replace(/([a-z\d])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z\d]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
}
