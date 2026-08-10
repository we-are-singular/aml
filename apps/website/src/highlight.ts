import { createBundledHighlighter } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"

/**
 * A single TSX grammar instance shared by every source example. Shiki uses
 * TextMate grammars, so JSX text, expressions, tags, and strings are tokenized
 * by the language rather than guessed from regular expressions.
 */
const createHighlighter = createBundledHighlighter({
  langs: {
    tsx: () => import("@shikijs/langs/tsx"),
  },
  themes: {
    "dark-plus": () => import("@shikijs/themes/dark-plus"),
  },
  engine: () => createJavaScriptRegexEngine(),
})

const highlighter = createHighlighter({
  themes: ["dark-plus"],
  langs: ["tsx"],
})

function codeContents(html: string): string {
  const start = html.indexOf("<code>")
  const end = html.lastIndexOf("</code>")
  return start === -1 || end === -1 ? "" : html.slice(start + "<code>".length, end)
}

/** Highlights a TSX sample for insertion inside an existing code block. */
export async function highlightTsx(source: string): Promise<string> {
  const instance = await highlighter
  return codeContents(instance.codeToHtml(source, { lang: "tsx", theme: "dark-plus" }))
}

/** Renders highlighted TSX into individually addressable lines for the playground. */
export async function highlightLines(source: string): Promise<string> {
  const html = await highlightTsx(source)
  const template = document.createElement("template")
  template.innerHTML = html

  return [...template.content.querySelectorAll(".line")]
    .map((line, index) => `<span class="code-line" data-line="${index + 1}">${line.innerHTML || "&nbsp;"}</span>`)
    .join("")
}
