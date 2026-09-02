import type { AmlRenderable } from "../../core/aml-node.js"
import { dedentMultilineText } from "../../core/multiline.js"

/** Exact blank-line separation and optional named prompt section. */
export interface BlockProps {
  /** Content preserved between two leading and two trailing newline characters. AML-empty markers count as no children. */
  readonly children?: AmlRenderable

  /**
   * Dedent a direct template-literal string child while preserving its semantic line structure.
   * Natural JSX text is already whitespace-normalized before Block receives it and cannot be recovered.
   */
  readonly multiline?: boolean

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
 * An empty Block, including one with a direct boolean or nullish child, is one
 * `"\n\n"` separator. A Block with children returns the transparent sequence
 * `"\n\n"`, children, `"\n\n"` so descriptors retain their existing nearest
 * Agent or resource owner. When `tag` is present, the children are additionally
 * wrapped in one kebab-cased XML-style section. With `multiline`, a direct
 * template-literal string child is dedented before the separators are added.
 */
export function Block({ children, multiline = false, tag }: BlockProps): AmlRenderable {
  if (children === null || children === undefined || typeof children === "boolean") return "\n\n"

  const content = multiline && typeof children === "string" ? dedentMultilineText(children) : children
  const sectionTag = tag === undefined ? undefined : normalizeBlockTag(tag)
  if (sectionTag === undefined || sectionTag.length === 0) {
    return ["\n\n", content, "\n\n"]
  }

  return ["\n\n", `<${sectionTag}>\n`, content, `\n</${sectionTag}>`, "\n\n"]
}

function normalizeBlockTag(tag: string): string {
  return tag
    .trim()
    .replace(/([a-z\d])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z\d]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
}
