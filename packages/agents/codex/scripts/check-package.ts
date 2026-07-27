import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { agentProviderConformance } from "@aml/sdk/testing"

interface PackResult {
  files: { path: string }[]
}

interface BuiltProviderPackage {
  codexAgent(options: {
    clientFactory: {
      create(options: {
        config: Record<string, unknown>
      }): {
        startThread(options: unknown): {
          run(
            prompt: string,
            options: unknown,
          ): Promise<{ finalResponse: string }>
        }
      }
    }
  }): {
    readonly name: string
    run: Parameters<typeof agentProviderConformance>[0]["run"]
  }
}

const packageDirectory = resolve(import.meta.dirname, "..")
const packageJson = JSON.parse(
  readFileSync(resolve(packageDirectory, "package.json"), "utf8"),
) as {
  dependencies: Record<string, string>
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
    "Codex provider exports do not match the reviewed dist-only contract",
  )
}

if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist"])) {
  throw new Error('Codex provider files must be exactly ["dist"]')
}

for (const dependency of [
  "@aml/sdk",
  "@modelcontextprotocol/sdk",
  "@openai/codex-sdk",
]) {
  if (packageJson.dependencies[dependency] === undefined) {
    throw new Error(
      `Codex provider must own its ${dependency} dependency`,
    )
  }
}

const entry = fileURLToPath(import.meta.resolve("@aml/agent-codex"))

if (!entry.startsWith(resolve(packageDirectory, "dist"))) {
  throw new Error(`Codex provider resolved outside dist: ${entry}`)
}

const built = (await import(
  pathToFileURL(entry).href
)) as BuiltProviderPackage
const calls = {
  create: 0,
  run: 0,
  startThread: 0,
}
let capturedConfig: Record<string, unknown> | undefined
const provider = built.codexAgent({
  clientFactory: {
    create(options) {
      calls.create += 1
      capturedConfig = options.config

      return {
        startThread() {
          calls.startThread += 1

          return {
            async run(prompt) {
              calls.run += 1
              return { finalResponse: prompt }
            },
          }
        },
      }
    },
  },
})

await agentProviderConformance(provider)

if (
  provider.name !== "codex" ||
  calls.create !== 1 ||
  calls.startThread !== 1 ||
  calls.run !== 2 ||
  (
    capturedConfig?.features as
      | { shell_tool?: unknown }
      | undefined
  )?.shell_tool !== false
) {
  throw new Error("Built Codex provider failed its package contract")
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
      `Codex provider package is missing ${expectedFile}`,
    )
  }
}

if ([...packedFiles].some((file) => file.startsWith("src/"))) {
  throw new Error("Codex provider package contains source files")
}

console.log(
  "Codex provider dist runtime, exports, and package are valid",
)
