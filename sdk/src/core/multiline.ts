import type { AmlRenderable } from "./aml-node.js"

/**
 * Authors multiline prompt text without leaking surrounding TSX indentation.
 *
 * The tag removes the first and last blank source lines and the indentation
 * shared by every non-blank line. Interpolated AML values retain their types
 * and authored positions so nodes, promises, and conditional content continue
 * through the normal evaluator rather than being stringified.
 */
export function multiline(strings: TemplateStringsArray, ...values: readonly AmlRenderable[]): AmlRenderable[] {
  // Dedentation must see the template as one document, including lines split by
  // interpolations. Private-use sentinels temporarily reserve each value's
  // position without coercing AML nodes, promises, or other renderables to text.
  const markerPrefix = uniqueTemplateMarkerPrefix(strings)
  const source = strings.reduce(
    (result, string, index) =>
      result + string + (index < values.length ? templateValueMarker(markerPrefix, index) : ""),
    ""
  )
  const content = dedentMultilineText(source)
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

/**
 * Removes indentation introduced by formatting multiline source code.
 *
 * At most one whitespace-only opening and closing line are removed. The
 * smallest indentation shared by all non-blank lines is removed, while deeper
 * indentation remains intact. Interior whitespace-only lines become empty
 * lines so source indentation does not leak into the rendered prompt.
 */
export function dedentMultilineText(source: string): string {
  const lines = source.split("\n")
  if (lines[0]?.trim().length === 0) lines.shift()
  if (lines.at(-1)?.trim().length === 0) lines.pop()

  const indentation = lines.reduce<number | undefined>((smallest, line) => {
    if (line.trim().length === 0) return smallest
    const width = line.match(/^[\t ]*/)?.[0].length ?? 0
    return smallest === undefined ? width : Math.min(smallest, width)
  }, undefined)

  if (indentation === undefined) return ""
  if (indentation === 0) return lines.map(line => (line.trim().length === 0 ? "" : line)).join("\n")
  return lines.map(line => (line.trim().length === 0 ? "" : line.slice(indentation))).join("\n")
}

function uniqueTemplateMarkerPrefix(strings: TemplateStringsArray): string {
  // U+E000 and U+E001 are Unicode private-use characters: valid string data
  // with no textual meaning in AML. Extend the prefix until none of the static
  // template segments contain it, making every generated marker unambiguous.
  let prefix = "\u{e000}aml-multiline"
  while (strings.some(string => string.includes(prefix))) prefix += "\u{e000}"
  return prefix
}

function templateValueMarker(prefix: string, index: number): string {
  // The index gives every interpolation a distinct token; U+E001 terminates it
  // so adjacent interpolations can be recovered without a delimiter in between.
  return `${prefix}-${index}\u{e001}`
}
