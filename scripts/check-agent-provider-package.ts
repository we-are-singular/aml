import { execFileSync } from "node:child_process"
import console from "node:console"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

interface PackResult {
  files: { path: string }[]
}

const [providerName, factoryName] = process.argv.slice(2)

if (providerName === undefined || factoryName === undefined) {
  throw new Error("Usage: check-agent-provider-package <provider-name> <factory-name>")
}

const packageDirectory = process.cwd()
const packageJson = JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8")) as {
  dependencies: Record<string, string>
  exports: Record<string, { import: string; types: string }>
  files: string[]
  name: string
}
const expectedExports = {
  ".": {
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  },
}

if (JSON.stringify(packageJson.exports) !== JSON.stringify(expectedExports)) {
  throw new Error(`${providerName} provider exports do not match the reviewed dist-only contract`)
}

if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist"])) {
  throw new Error(`${providerName} provider package files must be exactly ["dist"]`)
}

if (packageJson.dependencies["@aml-jsx/sdk"] === undefined) {
  throw new Error(`${providerName} provider must own its @aml-jsx/sdk dependency`)
}

const entry = fileURLToPath(import.meta.resolve(packageJson.name))

if (!entry.startsWith(resolve(packageDirectory, "dist"))) {
  throw new Error(`${providerName} provider resolved outside dist: ${entry}`)
}

const built = (await import(pathToFileURL(entry).href)) as Record<string, unknown>
const factory = built[factoryName]

if (typeof factory !== "function") {
  throw new Error(`${providerName} provider does not export ${factoryName}()`)
}

const provider = Reflect.apply(factory, undefined, []) as { readonly name?: unknown }

if (provider.name !== providerName) {
  throw new Error(`${providerName} provider factory returned an invalid provider`)
}

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: packageDirectory,
  encoding: "utf8",
})
const [packResult] = JSON.parse(packOutput) as PackResult[]
const packedFiles = new Set(packResult?.files.map(file => file.path))

for (const expectedFile of ["dist/index.d.ts", "dist/index.js"]) {
  if (!packedFiles.has(expectedFile)) {
    throw new Error(`${providerName} provider package is missing ${expectedFile}`)
  }
}

if ([...packedFiles].some(file => file.startsWith("src/"))) {
  throw new Error(`${providerName} provider package contains source files`)
}

console.log(`${providerName} provider dist runtime, exports, and package are valid`)
