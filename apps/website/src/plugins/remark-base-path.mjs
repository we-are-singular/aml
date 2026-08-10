/**
 * Prefixes authored root-relative documentation links with Astro's configured base.
 * This keeps the same MDX valid on a custom domain and on GitHub project pages.
 */
export default function remarkBasePath({ base }) {
  const prefix = `/${base.replace(/^\/+|\/+$/g, "")}`.replace(/^\/$/, "")

  return tree => {
    if (!prefix) return
    visit(tree, node => {
      if (typeof node.url === "string") node.url = withPrefix(node.url, prefix)

      for (const attribute of Array.isArray(node.attributes) ? node.attributes : []) {
        if ((attribute.name === "href" || attribute.name === "src") && typeof attribute.value === "string") {
          attribute.value = withPrefix(attribute.value, prefix)
        }
      }
    })
  }
}

function visit(node, callback) {
  callback(node)
  for (const child of Array.isArray(node.children) ? node.children : []) visit(child, callback)
}

function withPrefix(value, prefix) {
  if (!value.startsWith("/") || value.startsWith("//")) return value
  if (value === prefix || value.startsWith(`${prefix}/`)) return value
  return value === "/" ? `${prefix}/` : `${prefix}${value}`
}
