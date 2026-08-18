import { readFile } from "node:fs/promises"
import { URL } from "node:url"
import { createProcessor } from "@mdx-js/mdx"

const marker = "sandbox-changelog"
const changelogUrl = new URL("../../../../images/sandbox/CHANGELOG.md", import.meta.url)

/** Replaces the Docker changelog marker with the image package's release history. */
export default function remarkAgentSandboxChangelog() {
  return async tree => {
    const location = findMarker(tree)
    if (!location) return

    const changelog = await readFile(changelogUrl, "utf8")
    const parsed = createProcessor({ format: "md" }).parse(changelog)
    const releases = parsed.children.filter(node => node.type !== "heading" || node.depth !== 1)

    location.parent.children.splice(location.index, 1, ...releases)
  }
}

function findMarker(node) {
  if (!Array.isArray(node.children)) return undefined

  for (const [index, child] of node.children.entries()) {
    if (child.type === "mdxFlowExpression" && child.value.trim() === `/* ${marker} */`) {
      return { index, parent: node }
    }

    const nested = findMarker(child)
    if (nested) return nested
  }

  return undefined
}
