import { dirname, resolve } from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

import { getVariant, variantNames } from "./variants.mjs"

const imageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function main() {
  const argument = process.argv[2] ?? "full"
  const selectedVariants = argument === "--all" ? variantNames : [getVariant(argument).name]

  for (const name of selectedVariants) {
    const variant = getVariant(name)
    const primaryTag = name === "full" ? "aml-agent-sandbox:dev" : `aml-agent-sandbox:dev-${name}`
    const tags = name === "full" ? [primaryTag, "aml-agent-sandbox:dev-full"] : [primaryTag]
    const args = [
      "build",
      "--platform",
      "linux/amd64",
      "--build-arg",
      `IMAGE_VARIANT=${name}`,
      "--build-arg",
      `IMAGE_LICENSES=${variant.agents.includes("copilot") ? "MIT AND LicenseRef-GitHub-Copilot-CLI" : "MIT"}`,
      ...tags.flatMap(tag => ["--tag", tag]),
      ".",
    ]

    run("docker", args)
    const bytes = Number(output("docker", ["image", "inspect", "--format", "{{.Size}}", primaryTag]))
    process.stdout.write(`Built ${primaryTag} (${(bytes / 1024 / 1024).toFixed(1)} MiB)\n`)
  }
}

function output(command, args) {
  const result = spawnSync(command, args, { cwd: imageDirectory, encoding: "utf8" })
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    throw new Error(`${command} exited with status ${result.status}`)
  }
  return result.stdout.trim()
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: imageDirectory, stdio: "inherit" })
  if (result.error?.code === "ENOENT") throw new Error(`${command} is required to build the image`)
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
