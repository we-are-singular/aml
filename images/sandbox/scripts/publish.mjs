import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

import { getVariant, immutableTags, movingTags, variantNames } from "./variants.mjs"

const imageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = resolve(imageDirectory, "../..")
const dockerHubImage = "docker.io/wearesingular/aml-agent-sandbox"
const version = process.argv[2]

function main() {
  if (version === "--check") {
    requireCommand("docker", ["buildx", "version"])
    requireCommand("cosign", ["version"])
    process.stdout.write("Docker Buildx and Cosign are available\n")
    return
  }

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
    throw new Error("Expected a semantic version argument")
  }

  const packageVersion = JSON.parse(readFileSync(join(imageDirectory, "package.json"), "utf8")).version
  if (packageVersion !== version) {
    throw new Error(`Release version ${version} does not match package version ${packageVersion}`)
  }

  const revision = output("git", ["rev-parse", "HEAD"], repositoryRoot)
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "aml-agent-sandbox-release-"))

  try {
    const images = []

    // Publish immutable tags first so every live smoke runs against the exact
    // registry artifact that the stable aliases will eventually select.
    for (const name of variantNames) {
      const references = immutableTags(version, name).map(tag => `${dockerHubImage}:${tag}`)
      const digest = buildVariant(name, references, revision, temporaryDirectory)
      for (const reference of references) verifyDigest(reference, digest)
      images.push({ digest, name })
    }

    for (const image of images) {
      const immutableReference = `${dockerHubImage}@${image.digest}`
      run("node", ["scripts/check.mjs", image.name, immutableReference], imageDirectory)
      run(
        "npm",
        ["run", "smoke", "--", "--sandbox", "docker", ...(image.name === "full" ? [] : ["--agent", image.name])],
        repositoryRoot,
        { ...process.env, AML_SMOKE_SANDBOX_IMAGE: immutableReference }
      )
    }

    for (const image of images) {
      run("cosign", ["sign", "--yes", `${dockerHubImage}@${image.digest}`], repositoryRoot)
    }

    // Moving aliases change only after every immutable variant passes its real
    // Agent smoke, so a partial release does not replace working channels.
    for (const image of images) {
      for (const tag of movingTags(image.name)) {
        const reference = `${dockerHubImage}:${tag}`
        createTag(reference, image.digest)
        verifyDigest(reference, image.digest)
      }
    }

    process.stdout.write(
      `Published AML Agent Sandbox ${version}\n${images.map(image => `${image.name}: ${image.digest}`).join("\n")}\n`
    )
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()

function buildVariant(name, references, revision, temporaryDirectory) {
  const variant = getVariant(name)
  const metadataPath = join(temporaryDirectory, `${name}-metadata.json`)
  run(
    "docker",
    [
      "buildx",
      "build",
      "--platform",
      "linux/amd64",
      "--push",
      "--sbom=true",
      "--provenance=mode=max",
      "--build-arg",
      `IMAGE_VARIANT=${name}`,
      "--build-arg",
      `IMAGE_LICENSES=${variant.agents.includes("copilot") ? "MIT AND LicenseRef-GitHub-Copilot-CLI" : "MIT"}`,
      "--build-arg",
      `IMAGE_VERSION=${version}`,
      "--build-arg",
      `VCS_REF=${revision}`,
      ...references.flatMap(reference => ["--tag", reference]),
      "--metadata-file",
      metadataPath,
      imageDirectory,
    ],
    repositoryRoot
  )

  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"))
  const digest = metadata["containerimage.digest"]
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) {
    throw new Error(`Docker Buildx did not report a valid ${name} image digest`)
  }
  return digest
}

function createTag(reference, digest) {
  run("docker", ["buildx", "imagetools", "create", "--tag", reference, `${dockerHubImage}@${digest}`], repositoryRoot)
}

function verifyDigest(reference, expectedDigest) {
  const digest = output(
    "docker",
    ["buildx", "imagetools", "inspect", reference, "--format", "{{.Manifest.Digest}}"],
    repositoryRoot
  )
  if (digest !== expectedDigest) {
    throw new Error(`${reference} resolved to ${digest}, expected ${expectedDigest}`)
  }
}

function requireCommand(command, args) {
  const result = spawnSync(command, args, { stdio: "ignore" })
  if (result.error?.code === "ENOENT") {
    throw new Error(`${command} is required to publish the image`)
  }
  if (result.status !== 0) {
    throw new Error(`${command} is installed but unavailable`)
  }
}

function output(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" })
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    throw new Error(`${command} exited with status ${result.status}`)
  }
  return result.stdout.trim()
}

function run(command, args, cwd, environment = process.env) {
  const result = spawnSync(command, args, { cwd, env: environment, stdio: "inherit" })
  if (result.error?.code === "ENOENT") {
    throw new Error(`${command} is required to publish the image`)
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`)
  }
}
