import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

const commonDependencies = ["@aml-jsx/cli", "@aml-jsx/sdk"]

export const agentVariants = Object.freeze({
  codex: {
    commands: ["codex-acp", "codex"],
    dependencies: ["@agentclientprotocol/codex-acp", "@openai/codex"],
  },
  copilot: {
    commands: ["copilot"],
    dependencies: ["@github/copilot"],
  },
  glm: {
    commands: ["glm-acp-agent"],
    dependencies: ["glm-acp-agent"],
  },
  opencode: {
    commands: ["opencode"],
    dependencies: ["opencode-ai"],
  },
  pi: {
    commands: ["pi-acp", "pi", "pi-mcp-adapter"],
    dependencies: ["@earendil-works/pi-coding-agent", "pi-acp", "pi-mcp-adapter"],
  },
})

export const variantNames = Object.freeze(["full", ...Object.keys(agentVariants)])

/** Returns the npm packages and commands shipped by one image variant. */
export function getVariant(name) {
  if (name === "full") {
    return {
      agents: Object.keys(agentVariants),
      commands: Object.values(agentVariants).flatMap(variant => variant.commands),
      dependencies: [...commonDependencies, ...Object.values(agentVariants).flatMap(variant => variant.dependencies)],
      name,
    }
  }

  const agent = agentVariants[name]
  if (agent === undefined) {
    throw new TypeError(`Unknown image variant "${name}". Available: ${variantNames.join(", ")}`)
  }

  return {
    agents: [name],
    commands: agent.commands,
    dependencies: [...commonDependencies, ...agent.dependencies],
    name,
  }
}

/** Keeps only the selected variant's direct dependencies without changing their pinned versions. */
export function selectVariantDependencies(manifest, name) {
  const variant = getVariant(name)
  const dependencies = Object.fromEntries(
    variant.dependencies.map(dependency => {
      const version = manifest.dependencies?.[dependency]
      if (version === undefined) throw new Error(`Image dependency ${dependency} is missing from package.json`)
      return [dependency, version]
    })
  )
  return { ...manifest, dependencies }
}

export function immutableTags(version, name) {
  return name === "full" ? [version, `${version}-full`] : [`${version}-${name}`]
}

export function movingTags(name) {
  return name === "full" ? ["latest", "full"] : [name]
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, name, manifestPath = "package.json"] = process.argv.slice(2)
  if (command !== "prepare" || name === undefined) {
    throw new TypeError(`Usage: node scripts/variants.mjs prepare <${variantNames.join("|")}> [package.json]`)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  writeFileSync(manifestPath, `${JSON.stringify(selectVariantDependencies(manifest, name), null, 2)}\n`)
}
