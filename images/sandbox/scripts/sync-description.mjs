import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"

const dockerHubRepository = "wearesingular/aml-agent-sandbox"
const dockerHubServer = "https://index.docker.io/v1/"

async function main() {
  const [option] = process.argv.slice(2)
  if (option !== undefined && option !== "--check") {
    throw new Error(`Unknown option ${option}`)
  }

  const description = readFileSync(new URL("../DOCKERHUB.md", import.meta.url), "utf8")
  if (Buffer.byteLength(description) > 25_000) {
    throw new Error("Docker Hub repository overview exceeds its 25,000-byte limit")
  }

  const credential = readDockerCredential(process.env)
  const token = await authenticate(credential)
  const [namespace, repository] = dockerHubRepository.split("/")
  const repositoryUrl = `https://hub.docker.com/v2/namespaces/${namespace}/repositories/${repository}`

  if (option === "--check") {
    const response = await fetch(repositoryUrl, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) {
      throw new Error(`Docker Hub repository access failed: ${response.status} ${response.statusText}`)
    }
    process.stdout.write(`Docker Hub overview access is available for ${dockerHubRepository}\n`)
    return
  }

  const response = await fetch(repositoryUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ full_description: description }),
  })

  if (!response.ok) {
    throw new Error(`Docker Hub rejected the repository overview update: ${response.status} ${response.statusText}`)
  }

  const repositoryInfo = await response.json()
  if (repositoryInfo.full_description !== description) {
    throw new Error("Docker Hub did not return the published repository overview")
  }

  process.stdout.write(`Updated Docker Hub overview for ${dockerHubRepository}\n`)
}

function readDockerCredential(environment) {
  const configDirectory = environment.DOCKER_CONFIG ?? join(homedir(), ".docker")
  const config = JSON.parse(readFileSync(join(configDirectory, "config.json"), "utf8"))
  const auth = config.auths?.[dockerHubServer]?.auth ?? config.auths?.[`${dockerHubServer}refresh-token`]?.auth

  if (auth !== undefined) {
    const decoded = Buffer.from(auth, "base64").toString("utf8")
    const separator = decoded.indexOf(":")
    if (separator === -1) throw new Error("Docker Hub credential has an invalid format")
    return { username: decoded.slice(0, separator), secret: decoded.slice(separator + 1) }
  }

  const helperName = config.credHelpers?.[dockerHubServer] ?? config.credsStore
  if (helperName === undefined) {
    throw new Error("Docker Hub is not authenticated in the active Docker configuration")
  }

  const helper = spawnSync(`docker-credential-${helperName}`, ["get"], {
    encoding: "utf8",
    input: `${dockerHubServer}\n`,
  })
  if (helper.status !== 0) {
    throw new Error("Could not read the existing Docker Hub credential")
  }

  const credential = JSON.parse(helper.stdout)
  if (typeof credential.Username !== "string" || typeof credential.Secret !== "string") {
    throw new Error("Docker credential helper returned an invalid Docker Hub credential")
  }
  return { username: credential.Username, secret: credential.Secret }
}

async function authenticate({ username, secret }) {
  const response = await fetch("https://hub.docker.com/v2/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: username, secret }),
  })
  if (!response.ok) {
    throw new Error(`Docker Hub authentication failed: ${response.status} ${response.statusText}`)
  }

  const body = await response.json()
  const token = body.access_token ?? body.token
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Docker Hub authentication did not return an API token")
  }
  return token
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
