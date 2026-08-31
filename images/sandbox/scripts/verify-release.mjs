import { spawnSync } from "node:child_process"
import process from "node:process"

import { immutableTags, movingTags, variantNames } from "./variants.mjs"

const dockerHubImage = "docker.io/wearesingular/aml-agent-sandbox"
const [version, ...policyArguments] = process.argv.slice(2)

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  throw new Error("Expected a semantic version as the first argument")
}

const policy = parsePolicy(policyArguments)
const tag = `sandbox-v${version}`
const images = []

for (const name of variantNames) {
  const references = [...immutableTags(version, name), ...movingTags(name)].map(tag => `${dockerHubImage}:${tag}`)
  const digest = resolveDigest(references[0])
  for (const reference of references) verifyDigest(reference, digest)
  const immutableReference = `${dockerHubImage}@${digest}`

  run("cosign", [
    "verify",
    "--certificate-identity",
    policy.identity,
    "--certificate-oidc-issuer",
    policy.issuer,
    immutableReference,
  ])

  verifyAttestation("SBOM", "{{if .SBOM}}present{{else}}missing{{end}}", immutableReference)
  verifyAttestation("provenance", "{{if .Provenance}}present{{else}}missing{{end}}", immutableReference)
  images.push({ digest, name, references })
}

const release = JSON.parse(output("gh", ["release", "view", tag, "--json", "tagName,isDraft,isPrerelease,url"]))
if (release.tagName !== tag || release.isDraft || release.isPrerelease) {
  throw new Error(`GitHub Release ${tag} is missing or is not a final release`)
}

process.stdout.write(
  `Verified AML Agent Sandbox ${version}\n${images.map(image => `${image.name}: ${image.digest} (${image.references.join(", ")})`).join("\n")}\nGitHub Release: ${release.url}\n`
)

function parsePolicy(args) {
  let identity
  let issuer

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (value === undefined) throw new Error(`${flag} requires a value`)
    if (flag === "--certificate-identity") identity = value
    else if (flag === "--certificate-oidc-issuer") issuer = value
    else throw new Error(`Unknown verification option ${flag}`)
  }

  if (identity === undefined || issuer === undefined) {
    throw new Error("Verification requires exact --certificate-identity and --certificate-oidc-issuer values")
  }
  return { identity, issuer }
}

function verifyDigest(reference, expectedDigest) {
  const resolved = resolveDigest(reference)
  if (resolved !== expectedDigest) throw new Error(`${reference} resolved to ${resolved}, expected ${expectedDigest}`)
}

function resolveDigest(reference) {
  const digest = output("docker", ["buildx", "imagetools", "inspect", reference, "--format", "{{.Manifest.Digest}}"])
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`${reference} did not resolve to an immutable digest`)
  return digest
}

function verifyAttestation(name, format, reference) {
  const value = output("docker", ["buildx", "imagetools", "inspect", reference, "--format", format])
  if (value !== "present") throw new Error(`${reference} has no ${name} attestation`)
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (result.error?.code === "ENOENT") throw new Error(`${command} is required to verify the release`)
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    throw new Error(`${command} exited with status ${result.status}`)
  }
  return result.stdout.trim()
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" })
  if (result.error?.code === "ENOENT") throw new Error(`${command} is required to verify the release`)
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}
