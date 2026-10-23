import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

import { agentVariants, getVariant, variantNames } from "./variants.mjs"

const imageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const allAgentCommands = Object.values(agentVariants).flatMap(variant => variant.commands)
// The image's pinned Node build stage must match the release that local tooling and CI pin.
const nodeVersion = `v${readFileSync(resolve(imageDirectory, "../../.nvmrc"), "utf8").trim()}`
const { packageManager } = JSON.parse(readFileSync(resolve(imageDirectory, "../../package.json"), "utf8"))
const npmVersion = packageManager.slice(4)

function main() {
  const argument = process.argv[2] ?? "full"
  const selectedVariants = argument === "--all" ? variantNames : [getVariant(argument).name]
  const explicitImage = process.argv[3]

  if (argument === "--all" && explicitImage !== undefined) {
    throw new TypeError("An explicit image can only be checked with one variant")
  }

  for (const name of selectedVariants) {
    const variant = getVariant(name)
    const image = explicitImage ?? process.env.AML_AGENT_SANDBOX_IMAGE ?? localImage(name)
    const commands = variant.commands.join(" ")
    const excludedCommands = allAgentCommands.filter(command => !variant.commands.includes(command)).join(" ")

    run("docker", [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--tmpfs",
      "/workspace:rw,uid=1000,gid=1000",
      "--env",
      `AML_AGENT_SANDBOX_COMMANDS=${commands}`,
      "--env",
      `AML_AGENT_SANDBOX_EXCLUDED_COMMANDS=${excludedCommands}`,
      "--env",
      `AML_AGENT_SANDBOX_NODE_VERSION=${nodeVersion}`,
      "--env",
      `AML_AGENT_SANDBOX_NPM_VERSION=${npmVersion}`,
      "--volume",
      `${join(imageDirectory, "fixtures/clean-workspace")}:/fixture:ro`,
      "--volume",
      `${join(imageDirectory, "verify.sh")}:/verify.sh:ro`,
      image,
      "/verify.sh",
    ])

    run("docker", [
      "build",
      "--platform",
      "linux/amd64",
      "--build-arg",
      `AML_AGENT_SANDBOX_IMAGE=${image}`,
      "--build-arg",
      `AML_AGENT_SANDBOX_COMMANDS=${commands}`,
      "--build-arg",
      `AML_AGENT_SANDBOX_EXCLUDED_COMMANDS=${excludedCommands}`,
      "--file",
      join(imageDirectory, "fixtures/downstream.Dockerfile"),
      join(imageDirectory, "fixtures"),
    ])

    process.stdout.write(`Checked AML Agent Sandbox ${name} (${image})\n`)
  }
}

function localImage(name) {
  return name === "full" ? "aml-agent-sandbox:dev" : `aml-agent-sandbox:dev-${name}`
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: imageDirectory, stdio: "inherit" })
  if (result.error?.code === "ENOENT") throw new Error(`${command} is required to check the image`)
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
