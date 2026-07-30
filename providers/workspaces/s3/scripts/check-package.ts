import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import type { S3Client } from "@aws-sdk/client-s3"
import type { WorkspaceProvider } from "@aml-jsx/sdk"

interface PackResult {
  readonly files: readonly { readonly path: string }[]
}

interface BuiltS3WorkspacePackage {
  s3Workspace(options: { readonly bucket: string; readonly client: S3Client }): Readonly<WorkspaceProvider>
}

const packageDirectory = path.resolve(import.meta.dirname, "..")
const packageJson = JSON.parse(readFileSync(path.resolve(packageDirectory, "package.json"), "utf8")) as {
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
  throw new Error("S3 Workspace exports do not match the reviewed dist-only contract")
}

if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist"])) {
  throw new Error('S3 Workspace files must be exactly ["dist"]')
}

for (const dependency of ["@aml-jsx/sdk", "@aws-sdk/client-s3"]) {
  if (packageJson.dependencies[dependency] === undefined) {
    throw new Error(`S3 Workspace must own its ${dependency} runtime dependency`)
  }
}

const entry = fileURLToPath(import.meta.resolve("@aml-jsx/workspace-s3"))

if (!entry.startsWith(path.resolve(packageDirectory, "dist"))) {
  throw new Error(`S3 Workspace resolved outside dist: ${entry}`)
}

const built = (await import(pathToFileURL(entry).href)) as BuiltS3WorkspacePackage
const provider = built.s3Workspace({
  bucket: "package-check",
  client: {
    send() {
      throw new Error("Package check provider performed eager I/O")
    },
  } as unknown as S3Client,
})

if (provider.name !== "s3") {
  throw new Error("Built S3 Workspace did not expose its provider identity")
}

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: packageDirectory,
  encoding: "utf8",
})
const [packResult] = JSON.parse(packOutput) as PackResult[]
const packedFiles = new Set(packResult?.files.map(file => file.path))

for (const expectedFile of ["dist/index.d.ts", "dist/index.js"]) {
  if (!packedFiles.has(expectedFile)) {
    throw new Error(`S3 Workspace package is missing ${expectedFile}`)
  }
}

if ([...packedFiles].some(file => file.startsWith("src/"))) {
  throw new Error("S3 Workspace package contains source files")
}

console.log("S3 Workspace dist runtime, exports, dependencies, and package are valid")
