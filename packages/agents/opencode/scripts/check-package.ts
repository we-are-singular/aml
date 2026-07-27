import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolve } from "node:path"

import { agentProviderConformance } from "@aml/sdk/testing"

interface PackResult {
  files: { path: string }[]
}

interface BuiltProviderPackage {
  opencodeAgent(options: {
    sessionClient: {
      abort(input: unknown): Promise<void>
      create(input: unknown, signal: AbortSignal): Promise<string>
      delete(input: unknown): Promise<void>
      prompt(
        input: unknown,
        signal: AbortSignal,
      ): Promise<{ parts: { text: string; type: string }[] }>
    }
  }): {
    close(): Promise<void>
    readonly name: string
    run: Parameters<typeof agentProviderConformance>[0]["run"]
  }
}

const packageDirectory = resolve(import.meta.dirname, "..")
const packageJson = JSON.parse(
  readFileSync(resolve(packageDirectory, "package.json"), "utf8"),
) as {
  exports: Record<string, { import: string; types: string }>
  files: string[]
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
    "OpenCode provider exports do not match the reviewed dist-only contract",
  )
}

if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist"])) {
  throw new Error('OpenCode provider files must be exactly ["dist"]')
}

const entry = fileURLToPath(import.meta.resolve("@aml/agent-opencode"))

if (!entry.startsWith(resolve(packageDirectory, "dist"))) {
  throw new Error(`OpenCode provider resolved outside dist: ${entry}`)
}

const built = (await import(
  pathToFileURL(entry).href
)) as BuiltProviderPackage
const calls = {
  abort: 0,
  create: 0,
  delete: 0,
  prompt: 0,
}
const provider = built.opencodeAgent({
  sessionClient: {
    async abort() {
      calls.abort += 1
    },
    async create() {
      calls.create += 1
      return "package-check-session"
    },
    async delete() {
      calls.delete += 1
    },
    async prompt() {
      calls.prompt += 1
      return {
        parts: [{ text: "agent-provider-conformance", type: "text" }],
      }
    },
  },
})

await agentProviderConformance(provider)
await provider.close()

if (
  provider.name !== "opencode" ||
  calls.create !== 1 ||
  calls.prompt !== 1 ||
  calls.delete !== 1 ||
  calls.abort !== 0
) {
  throw new Error("Built OpenCode provider failed its package contract")
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
const packedFiles = new Set(packResult?.files.map((file) => file.path))

for (const expectedFile of ["dist/index.d.ts", "dist/index.js"]) {
  if (!packedFiles.has(expectedFile)) {
    throw new Error(`OpenCode provider package is missing ${expectedFile}`)
  }
}

if ([...packedFiles].some((file) => file.startsWith("src/"))) {
  throw new Error("OpenCode provider package contains source files")
}

console.log("OpenCode provider dist runtime, exports, and package are valid")
