import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import process from "node:process"
import { URL } from "node:url"

const releaseArguments = process.argv.slice(2)
const skipsPublishing = releaseArguments.some(argument => ["--dry-run", "--help", "--version"].includes(argument))
const recoversRelease = releaseArguments.includes("--recover")

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

function release() {
  const recoveryVersion = recoversRelease ? readRecoveryVersion() : undefined

  // Reading the active account locally keeps a GitHub API outage from blocking
  // Docker Hub authentication or the release preflight.
  const githubUsername = readActiveGithubUsername()
  const githubToken = output("gh", ["auth", "token"], process.env)

  // Each release gets isolated registry credentials. This avoids mutating the
  // Docker Desktop vault and guarantees that cleanup removes the release tokens.
  const dockerConfig = mkdtempSync(join(tmpdir(), "aml-agent-sandbox-auth-"))
  const releaseEnvironment = { ...process.env, DOCKER_CONFIG: dockerConfig, GITHUB_TOKEN: githubToken }

  try {
    runOrThrow("docker", ["login"], releaseEnvironment)
    runOrThrow(
      "docker",
      ["login", "ghcr.io", "--username", githubUsername, "--password-stdin"],
      releaseEnvironment,
      `${githubToken}\n`
    )

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
  const expectedTag = `docker-v${packageVersion}`
  const tagAtHead = output("git", ["tag", "--points-at", "HEAD", "--list", expectedTag], process.env)
  if (tagAtHead !== expectedTag) {
    throw new Error(`HEAD must have tag ${expectedTag} to recover this release`)
  }

  return packageVersion
}

function ensureGithubRelease(version, environment) {
  const tag = `docker-v${version}`
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

  runOrThrow(
    "gh",
    ["release", "create", tag, "--verify-tag", "--generate-notes", "--title", `AML Agent Sandbox v${version}`],
    environment
  )
}

function readActiveGithubUsername() {
  const configDirectory =
    process.env.GH_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gh")
  const hostsPath = join(configDirectory, "hosts.yml")
  let hosts

  try {
    hosts = readFileSync(hostsPath, "utf8")
  } catch {
    throw new Error(`GitHub CLI authentication was not found; run gh auth login`)
  }

  const lines = hosts.split(/\r?\n/)
  const hostIndex = lines.findIndex(line => line === "github.com:")
  if (hostIndex === -1) {
    throw new Error(`GitHub CLI is not authenticated with github.com; run gh auth login`)
  }

  // `user` is a direct child of the host. Restricting the indentation prevents
  // accidentally reading keys from the nested accounts or OAuth-token entries.
  const directChild = lines.slice(hostIndex + 1).find(line => /^\s+\S/.test(line))
  const directIndent = directChild?.match(/^\s+/)?.[0]
  if (!directIndent) {
    throw new Error(`GitHub CLI has no active github.com account; run gh auth login`)
  }

  for (const line of lines.slice(hostIndex + 1)) {
    if (/^\S/.test(line)) break
    const match = line.match(new RegExp(`^${directIndent}user:\\s*([A-Za-z0-9-]+)\\s*$`))
    if (match) return match[1]
  }

  throw new Error(`GitHub CLI has no active github.com account; run gh auth switch`)
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

function runOrThrow(command, args, environment, input) {
  const result = spawnSync(command, args, {
    env: environment,
    input,
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
  })
  if (result.error?.code === "ENOENT") {
    throw new Error(`${command} is required to release the image`)
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`)
  }
}
