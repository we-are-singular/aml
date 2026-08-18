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
