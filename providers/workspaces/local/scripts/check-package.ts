import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import type { WorkspaceProvider } from "@aml-jsx/sdk"
import { workspaceProviderConformance } from "@aml-jsx/sdk/testing"

interface PackResult {
  readonly files: readonly { readonly path: string }[]
}

interface BuiltLocalWorkspacePackage {
  filesystemWorkspace(options: {
    readonly directory: string
    readonly temporaryDirectory: string
  }): Readonly<WorkspaceProvider>
  localWorkspace(options: { readonly directory: string }): Readonly<WorkspaceProvider>
}

const packageDirectory = path.resolve(import.meta.dirname, "..")
const packageJson = JSON.parse(readFileSync(path.resolve(packageDirectory, "package.json"), "utf8")) as {
  readonly dependencies: Readonly<Record<string, string>>
  readonly devDependencies: Readonly<Record<string, string>>
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
  throw new Error("Local Workspace exports do not match the reviewed dist-only contract")
}

if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist"])) {
  throw new Error('Local Workspace files must be exactly ["dist"]')
}

if (
  packageJson.dependencies["@aml-jsx/sdk"] === undefined ||
  packageJson.dependencies["proper-lockfile"] === undefined ||
  packageJson.devDependencies["@types/proper-lockfile"] === undefined
) {
  throw new Error("Local Workspace must own its SDK, lock runtime, and private lock types")
}

const entry = fileURLToPath(import.meta.resolve("@aml-jsx/workspace-local"))

if (!entry.startsWith(path.resolve(packageDirectory, "dist"))) {
  throw new Error(`Local Workspace resolved outside dist: ${entry}`)
}

const built = (await import(pathToFileURL(entry).href)) as BuiltLocalWorkspacePackage
const directory = mkdtempSync(path.join(tmpdir(), "aml-local-package-check-"))

try {
  const provider = built.localWorkspace({ directory })

  await workspaceProviderConformance(provider)

  if (provider.name !== "local") {
    throw new Error("Built Local Workspace failed its provider lifecycle contract")
  }

  const staged = built.filesystemWorkspace({
    directory,
    temporaryDirectory: tmpdir(),
  })

  if (staged.name !== "filesystem") {
    throw new Error("Built Filesystem Workspace failed its provider identity contract")
  }
} finally {
  rmSync(directory, { force: true, recursive: true })
  rmSync(`${directory}.lock`, { force: true, recursive: true })
}

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: packageDirectory,
  encoding: "utf8",
})
const [packResult] = JSON.parse(packOutput) as PackResult[]
const packedFiles = new Set(packResult?.files.map(file => file.path))

for (const expectedFile of ["dist/index.d.ts", "dist/index.js"]) {
  if (!packedFiles.has(expectedFile)) {
    throw new Error(`Local Workspace package is missing ${expectedFile}`)
  }
}

if ([...packedFiles].some(file => file.startsWith("src/"))) {
  throw new Error("Local Workspace package contains source files")
}

console.log("Local Workspace dist runtime, lifecycle, exports, and package are valid")
