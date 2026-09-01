import type { AmlRenderable } from "./aml-node.js"

/**
 * Authors multiline Markdown without leaking surrounding TSX indentation.
 *
 * The tag removes the first and last blank source lines and the indentation
 * shared by every non-blank line. Interpolated AML values retain their types
 * and authored positions so nodes, promises, and conditional content continue
 * through the normal evaluator rather than being stringified.
 */
export function markdown(strings: TemplateStringsArray, ...values: readonly AmlRenderable[]): AmlRenderable {
  const markerPrefix = uniqueTemplateMarkerPrefix(strings)
  const source = strings.reduce(
    (result, string, index) =>
      result + string + (index < values.length ? templateValueMarker(markerPrefix, index) : ""),
    ""
  )
  const content = stripFormattingIndentation(source)
  const result: AmlRenderable[] = []
  let start = 0

  for (const [valueIndex, value] of values.entries()) {
    const marker = templateValueMarker(markerPrefix, valueIndex)
    const index = content.indexOf(marker, start)
    if (index > start) result.push(content.slice(start, index))
    result.push(value)
    start = index + marker.length
  }

  if (start < content.length) result.push(content.slice(start))
  return result
}

function uniqueTemplateMarkerPrefix(strings: TemplateStringsArray): string {
  let prefix = "\u{e000}aml-markdown"
  while (strings.some(string => string.includes(prefix))) prefix += "\u{e000}"
  return prefix
}

function templateValueMarker(prefix: string, index: number): string {
  return `${prefix}-${index}\u{e001}`
}

function stripFormattingIndentation(source: string): string {
  const lines = source.split("\n")
  if (lines[0]?.trim().length === 0) lines.shift()
  if (lines.at(-1)?.trim().length === 0) lines.pop()

  const indentation = lines.reduce<number | undefined>((smallest, line) => {
    if (line.trim().length === 0) return smallest
    const width = line.match(/^[\t ]*/)?.[0].length ?? 0
    return smallest === undefined ? width : Math.min(smallest, width)
  }, undefined)

  if (indentation === undefined || indentation === 0) return lines.join("\n")
  return lines.map(line => (line.trim().length === 0 ? "" : line.slice(indentation))).join("\n")
}
