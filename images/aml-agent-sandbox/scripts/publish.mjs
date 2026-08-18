import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const imageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = resolve(imageDirectory, "../..")
const dockerHubImage = "docker.io/wearesingular/aml-agent-sandbox"
const version = process.argv[2]

function main() {
  if (version === "--check") {
    requireCommand("docker", ["buildx", "version"])
    requireCommand("cosign", ["version"])
    verifyAttestationBuilder()
    process.stdout.write("Docker image publishing tools and attestation builder are available\n")
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
  const shortRevision = revision.slice(0, 12)
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "aml-agent-sandbox-release-"))
  const metadataPath = join(temporaryDirectory, "build-metadata.json")

  try {
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
        `IMAGE_VERSION=${version}`,
        "--build-arg",
        `VCS_REF=${revision}`,
        "--tag",
        `${dockerHubImage}:${version}`,
        "--tag",
        `${dockerHubImage}:sha-${shortRevision}`,
        "--tag",
        `${dockerHubImage}:latest`,
        "--metadata-file",
        metadataPath,
        imageDirectory,
      ],
      repositoryRoot
    )

    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"))
    const digest = metadata["containerimage.digest"]
    if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) {
      throw new Error("Docker Buildx did not report a valid image digest")
    }

    verifyDigest(`${dockerHubImage}:${version}`, digest)

    run("cosign", ["sign", "--yes", `${dockerHubImage}@${digest}`], repositoryRoot)

    process.stdout.write(`Published AML Agent Sandbox ${version}\nDigest: ${digest}\n`)
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()

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

function verifyAttestationBuilder() {
  const inspection = output("docker", ["buildx", "inspect", "--bootstrap"], repositoryRoot)
  const builder = parseBuilderInspection(inspection)
  const dockerInfo =
    builder.driver === "docker"
      ? JSON.parse(output("docker", ["info", "--format", "{{json .}}"], repositoryRoot))
      : undefined
  assertBuilderSupportsAttestations(builder, dockerInfo)
}

export function parseBuilderInspection(inspection) {
  const name = /^Name:\s+(.+)$/m.exec(inspection)?.[1]?.trim()
  const driver = /^Driver:\s+(.+)$/m.exec(inspection)?.[1]?.trim()
  const buildkitVersions = [...inspection.matchAll(/^BuildKit version:\s+v?([^\s]+)$/gm)].map(match => match[1])

  if (name === undefined || driver === undefined) {
    throw new Error("Could not determine the current Buildx builder name and driver from docker buildx inspect")
  }
  if (buildkitVersions.length === 0) {
    throw new Error(`Could not determine BuildKit version for Buildx builder ${name}`)
  }

  return { buildkitVersions, driver, name }
}

export function usesContainerdImageStore(dockerInfo) {
  return dockerInfo.DriverStatus?.some(
    status => Array.isArray(status) && status[0] === "driver-type" && status[1] === "io.containerd.snapshotter.v1"
  )
}

export function assertBuilderSupportsAttestations(builder, dockerInfo) {
  if (!builder.buildkitVersions.every(supportsBuildAttestations)) {
    throw new Error(
      `Buildx builder ${builder.name} uses BuildKit ${builder.buildkitVersions.join(", ") || "of unknown version"}; SBOM and provenance require BuildKit 0.11 or newer`
    )
  }

  if (builder.driver !== "docker" || usesContainerdImageStore(dockerInfo ?? {})) return

  throw new Error(
    `Buildx builder ${builder.name} uses the docker driver with the classic image store, which cannot publish SBOM and provenance attestations. Select an existing docker-container builder with "docker buildx use <name>" (or BUILDX_BUILDER=<name> npm run release:docker), or enable Docker's containerd image store, then retry. The release script does not create or switch builders.`
  )
}

function supportsBuildAttestations(version) {
  const [major, minor] = version.split(".").map(value => Number.parseInt(value, 10))
  return Number.isInteger(major) && Number.isInteger(minor) && (major > 0 || minor >= 11)
}

function output(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" })
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    throw new Error(`${command} exited with status ${result.status}`)
  }
  return result.stdout.trim()
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" })
  if (result.error?.code === "ENOENT") {
    throw new Error(`${command} is required to publish the image`)
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`)
  }
}
