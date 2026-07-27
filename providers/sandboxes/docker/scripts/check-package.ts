import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"

import Dockerode from "dockerode"

import { sandboxProviderConformance } from "@aml/sdk/testing"

interface PackResult {
  readonly files: readonly { readonly path: string }[]
}

interface BuiltDockerPackage {
  dockerSandbox(options: {
    readonly client: Dockerode
    readonly image: string
    readonly workspace: string
  }): Parameters<typeof sandboxProviderConformance>[0]
}

const packageDirectory = resolve(import.meta.dirname, "..")
const packageJson = JSON.parse(
  readFileSync(resolve(packageDirectory, "package.json"), "utf8"),
) as {
  readonly dependencies: Readonly<Record<string, string>>
  readonly exports: Readonly<
    Record<string, { readonly import: string; readonly types: string }>
  >
  readonly files: readonly string[]
}

if (
  JSON.stringify(packageJson.exports) !==
  JSON.stringify({
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    },
  })
) {
  throw new Error(
    "Docker Sandbox exports do not match the reviewed dist-only contract",
  )
}

if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist"])) {
  throw new Error('Docker Sandbox files must be exactly ["dist"]')
}

if (
  packageJson.dependencies.dockerode === undefined ||
  packageJson.dependencies["@types/dockerode"] === undefined ||
  packageJson.dependencies["@aml/sdk"] === undefined
) {
  throw new Error(
    "Docker Sandbox must own its Dockerode runtime, public types, and SDK dependencies",
  )
}

const entry = fileURLToPath(
  import.meta.resolve("@aml/sandbox-docker"),
)

if (!entry.startsWith(resolve(packageDirectory, "dist"))) {
  throw new Error(`Docker Sandbox resolved outside dist: ${entry}`)
}

const built = (await import(
  pathToFileURL(entry).href
)) as BuiltDockerPackage
const client = new Dockerode()
const container = client.getContainer("package-check-container")
const execution = client.getExec("package-check-exec")
let created = 0
let released = 0
let createOptions: Dockerode.ContainerCreateOptions | undefined

// The package check exercises built output without requiring a live daemon.
// Dockerode remains the concrete injected dependency, while only its Engine
// methods are replaced with deterministic responses.
client.getContainer = () => container
client.createContainer = async (options) => {
  created += 1
  createOptions = options
  return container
}
container.start = async () => undefined
container.remove = async () => {
  released += 1
}
container.exec = async () => execution
execution.start = async () => {
  const probe = createOptions?.HostConfig?.Mounts?.find(
    (mount) => mount.Target === "/run/aml-host-namespace",
  )

  if (probe === undefined) {
    throw new Error("Built Docker Sandbox omitted its namespace probe")
  }

  const stream = new PassThrough()
  stream.end(
    dockerFrame(
      1,
      readFileSync(resolve(probe.Source, "identity"), "utf8"),
    ),
  )
  return stream
}
execution.inspect = async () =>
  ({ ExitCode: 0 }) as Dockerode.ExecInspectInfo

const provider = built.dockerSandbox({
  client,
  image: "alpine:3.22",
  workspace: packageDirectory,
})

await sandboxProviderConformance(provider)

if (
  provider.name !== "docker" ||
  created !== 1 ||
  released !== 1
) {
  throw new Error(
    "Built Docker Sandbox failed its provider lifecycle contract",
  )
}

const packOutput = execFileSync(
  "npm",
  ["pack", "--dry-run", "--ignore-scripts", "--json"],
  {
    cwd: packageDirectory,
    encoding: "utf8",
  },
)
const [packResult] = JSON.parse(packOutput) as PackResult[]
const packedFiles = new Set(
  packResult?.files.map((file) => file.path),
)

for (const expectedFile of ["dist/index.d.ts", "dist/index.js"]) {
  if (!packedFiles.has(expectedFile)) {
    throw new Error(
      `Docker Sandbox package is missing ${expectedFile}`,
    )
  }
}

if ([...packedFiles].some((file) => file.startsWith("src/"))) {
  throw new Error("Docker Sandbox package contains source files")
}

console.log(
  "Docker Sandbox dist runtime, lifecycle, exports, and package are valid",
)

/**
 * Encodes one Docker raw-stream frame for the real demultiplexer.
 */
function dockerFrame(stream: 1 | 2, value: string): Buffer {
  const content = Buffer.from(value)
  const header = Buffer.alloc(8)
  header.writeUInt8(stream, 0)
  header.writeUInt32BE(content.byteLength, 4)
  return Buffer.concat([header, content])
}
