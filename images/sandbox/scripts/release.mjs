import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import process from "node:process"
import { pathToFileURL, URL } from "node:url"

const releaseArguments = process.argv.slice(2)
const skipsPublishing = releaseArguments.some(argument => ["--dry-run", "--help", "--version"].includes(argument))
const recoversRelease = releaseArguments.includes("--recover")
const publisherBuilder = "aml-agent-sandbox-publisher"

export function main() {
  try {
    if (recoversRelease && releaseArguments.length !== 1) {
      throw new Error(`--recover cannot be combined with other release arguments`)
    }

    if (skipsPublishing) {
      const previewEnvironment = { ...process.env }
      if (releaseArguments.includes("--dry-run")) {
        previewEnvironment.GITHUB_TOKEN = output("gh", ["auth", "token"], process.env)
      }
      process.exitCode = run("release-it", releaseArguments, previewEnvironment)
    } else {
      process.exitCode = release()
    }
  } catch (error) {
    process.stderr.write(`Release failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
}

function release() {
  const recoveryVersion = recoversRelease ? readRecoveryVersion() : undefined

  // Fail before Docker authentication or Release It can create a commit/tag.
  // The check uses the caller's Buildx state assembled below.
  const releaseEnvironment = createReleaseEnvironment(process.env)
  const dockerConfig = releaseEnvironment.DOCKER_CONFIG

  try {
    runOrThrow("node", ["scripts/publish.mjs", "--check"], releaseEnvironment)
    prepareBuildx(releaseEnvironment)

    // Release It uses the active CLI token for the source tag's GitHub Release.
    // Stable image publication itself authenticates only with Docker Hub.
    releaseEnvironment.GITHUB_TOKEN = output("gh", ["auth", "token"], process.env)
    runOrThrow("docker", ["login"], releaseEnvironment)

    if (recoveryVersion) {
      runOrThrow("node", ["scripts/publish.mjs", recoveryVersion], releaseEnvironment)
      ensureGithubRelease(recoveryVersion, releaseEnvironment)
      process.stdout.write(`Recovered AML Agent Sandbox ${recoveryVersion}\n`)
      return 0
    }

    return run("release-it", releaseArguments, releaseEnvironment)
  } finally {
    rmSync(dockerConfig, { recursive: true, force: true })
  }
}

/**
 * Keeps an explicit or attestation-capable builder and supplies a private
 * docker-container fallback when the selected Docker driver cannot attest.
 */
function prepareBuildx(environment) {
  const driver = parseBuildxDriver(output("docker", ["buildx", "inspect"], environment))
  if (driver !== "docker") {
    runOrThrow("docker", ["buildx", "inspect", "--bootstrap"], environment)
    return
  }

  const existingBuilder = spawnSync("docker", ["buildx", "inspect", publisherBuilder], {
    encoding: "utf8",
    env: environment,
  })
  if (existingBuilder.error?.code === "ENOENT") {
    throw new Error(`docker is required to release the image`)
  }

  if (existingBuilder.status === 0) {
    if (parseBuildxDriver(existingBuilder.stdout) === "docker") {
      throw new Error(`Buildx builder ${publisherBuilder} must use the docker-container driver`)
    }
    runOrThrow("docker", ["buildx", "inspect", publisherBuilder, "--bootstrap"], environment)
  } else {
    runOrThrow(
      "docker",
      ["buildx", "create", "--name", publisherBuilder, "--driver", "docker-container", "--bootstrap"],
      environment
    )
  }

  environment.BUILDX_BUILDER = publisherBuilder
}

/** Extracts the selected Buildx driver from its stable inspect output. */
export function parseBuildxDriver(value) {
  const driver = /^Driver:\s*(\S+)\s*$/m.exec(value)?.[1]
  if (driver === undefined) {
    throw new Error(`Docker Buildx did not report its selected driver`)
  }
  return driver
}

/**
 * Isolates registry credentials while retaining the caller's named builders,
 * current-builder selection, BuildKit configuration, and build history.
 */
function createReleaseEnvironment(environment) {
  const callerDockerConfig = environment.DOCKER_CONFIG ?? join(homedir(), ".docker")
  const dockerConfig = mkdtempSync(join(tmpdir(), "aml-sandbox-auth-"))

  return {
    ...environment,
    BUILDX_CONFIG: environment.BUILDX_CONFIG ?? join(callerDockerConfig, "buildx"),
    DOCKER_CONFIG: dockerConfig,
  }
}

function readRecoveryVersion() {
  const branch = output("git", ["branch", "--show-current"], process.env)
  if (branch !== "main") {
    throw new Error(`Recovery must run from branch main`)
  }

  const changes = output("git", ["status", "--porcelain"], process.env)
  if (changes) {
    throw new Error(`Recovery requires a clean worktree`)
  }

  const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version
  const expectedTag = `sandbox-v${packageVersion}`
  const tagAtHead = output("git", ["tag", "--points-at", "HEAD", "--list", expectedTag], process.env)
  if (tagAtHead !== expectedTag) {
    throw new Error(`HEAD must have tag ${expectedTag} to recover this release`)
  }

  return packageVersion
}

function ensureGithubRelease(version, environment) {
  const tag = `sandbox-v${version}`
  const existingRelease = spawnSync("gh", ["release", "view", tag], {
    encoding: "utf8",
    env: environment,
  })
  if (existingRelease.error?.code === "ENOENT") {
    throw new Error(`gh is required to recover the image release`)
  }
  if (existingRelease.status === 0) return

  // A missing release is the expected state when publication failed in the
  // after:git:release hook. Other API errors must remain visible and retryable.
  if (!/release not found|HTTP 404/i.test(existingRelease.stderr)) {
    process.stderr.write(existingRelease.stderr)
    throw new Error(`Could not check GitHub Release ${tag}`)
  }

  const previousTag = output("git", ["describe", "--tags", "--match=[ds]*-v*", "--abbrev=0", "HEAD^"], environment)
  const notes = output("node", ["../../scripts/release-notes.ts", "sandbox", previousTag, "HEAD^"], environment)
  runOrThrow(
    "gh",
    ["release", "create", tag, "--verify-tag", "--notes", notes, "--title", `sandbox v${version}`],
    environment
  )
}

function output(command, args, environment) {
  const result = spawnSync(command, args, { encoding: "utf8", env: environment })
  if (result.error?.code === "ENOENT") {
    throw new Error(`${command} is required to release the image`)
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    throw new Error(`${command} exited with status ${result.status}`)
  }
  return result.stdout.trim()
}

function run(command, args, environment) {
  const result = spawnSync(command, args, { env: environment, stdio: "inherit" })
  if (result.error?.code === "ENOENT") {
    throw new Error(`${command} is required to release the image`)
  }
  return result.status ?? 1
}

function runOrThrow(command, args, environment) {
  const result = spawnSync(command, args, {
    env: environment,
    stdio: "inherit",
  })
  if (result.error?.code === "ENOENT") {
    throw new Error(`${command} is required to release the image`)
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`)
  }
}
