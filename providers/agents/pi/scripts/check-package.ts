import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { agentProviderConformance } from "@aml-jsx/sdk/testing"

interface PackResult {
  files: { path: string }[]
}

interface BuiltProviderPackage {
  piAgent(options: {
    clientFactory: {
      create(): {
        abort(): Promise<void>
        dispose(): void
        prompt(prompt: string): Promise<string>
      }
    }
  }): {
    readonly name: string
    run: Parameters<typeof agentProviderConformance>[0]["run"]
  }
}

const packageDirectory = resolve(import.meta.dirname, "..")
const packageJson = JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8")) as {
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
  throw new Error("Pi provider exports do not match the reviewed dist-only contract")
}

if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist"])) {
  throw new Error('Pi provider files must be exactly ["dist"]')
}

for (const dependency of ["@aml-jsx/sdk", "@earendil-works/pi-coding-agent", "typebox"]) {
  if (packageJson.dependencies[dependency] === undefined) {
    throw new Error(`Pi provider must own its ${dependency} dependency`)
  }
}

const entry = fileURLToPath(import.meta.resolve("@aml-jsx/agent-pi"))

if (!entry.startsWith(resolve(packageDirectory, "dist"))) {
  throw new Error(`Pi provider resolved outside dist: ${entry}`)
}

const built = (await import(pathToFileURL(entry).href)) as BuiltProviderPackage
const prompts: string[] = []
let disposals = 0
const provider = built.piAgent({
  clientFactory: {
    create() {
      return {
        async abort() {},
        dispose() {
          disposals += 1
        },
        async prompt(prompt) {
          prompts.push(prompt)
          return prompt
        },
      }
    },
  },
})

await agentProviderConformance(provider)

if (
  provider.name !== "pi" ||
  prompts.join("|") !== "agent-provider-conformance|agent-provider-conformance-final" ||
  disposals !== 1
) {
  throw new Error("Built Pi provider failed its package contract")
}

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: packageDirectory,
  encoding: "utf8",
})
const [packResult] = JSON.parse(packOutput) as PackResult[]
const packedFiles = new Set(packResult?.files.map(file => file.path))

for (const expectedFile of ["dist/index.d.ts", "dist/index.js"]) {
  if (!packedFiles.has(expectedFile)) {
    throw new Error(`Pi provider package is missing ${expectedFile}`)
  }
}

if ([...packedFiles].some(file => file.startsWith("src/"))) {
  throw new Error("Pi provider package contains source files")
}

console.log("Pi provider dist runtime, exports, and package are valid")
