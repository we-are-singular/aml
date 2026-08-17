import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import type { SandboxProvider } from "@aml-jsx/sdk"

interface PackResult {
  readonly files: readonly { readonly path: string }[]
}

interface BuiltDockerPackage {
  dockerSandbox(options: {
    readonly image: string
    readonly setup?: string
    readonly workspace?: string
  }): Readonly<SandboxProvider>
}

const packageDirectory = resolve(import.meta.dirname, "..")
const packageJson = JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8")) as {
  readonly dependencies: Readonly<Record<string, string>>
  readonly exports: Readonly<Record<string, { readonly import: string; readonly types: string }>>
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
  throw new Error("Docker Sandbox exports do not match the reviewed dist-only contract")
}

if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist"])) {
  throw new Error('Docker Sandbox files must be exactly ["dist"]')
}

if (packageJson.dependencies["@aml-jsx/sdk"] === undefined || Object.keys(packageJson.dependencies).length !== 1) {
  throw new Error("Docker Sandbox must depend only on the provider-neutral SDK")
}

const entry = fileURLToPath(import.meta.resolve("@aml-jsx/sandbox-docker"))

if (!entry.startsWith(resolve(packageDirectory, "dist"))) {
  throw new Error(`Docker Sandbox resolved outside dist: ${entry}`)
}

const built = (await import(pathToFileURL(entry).href)) as BuiltDockerPackage
const provider = built.dockerSandbox({ image: "alpine:3.22" })

if (provider.name !== "docker") {
  throw new Error("Built Docker Sandbox failed its inert factory contract")
}

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: packageDirectory,
  encoding: "utf8",
})
// npm pack --json returns an array of one element; npm 12 changes this shape.
const [packResult] = JSON.parse(packOutput) as PackResult[]
const packedFiles = new Set(packResult?.files.map(file => file.path))

for (const expectedFile of ["dist/index.d.ts", "dist/index.js"]) {
  if (!packedFiles.has(expectedFile)) {
    throw new Error(`Docker Sandbox package is missing ${expectedFile}`)
  }
}

if ([...packedFiles].some(file => file.startsWith("src/"))) {
  throw new Error("Docker Sandbox package contains source files")
}

console.log("Docker Sandbox image-first factory, exports, and package are valid")
