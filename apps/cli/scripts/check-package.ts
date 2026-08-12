import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import console from "node:console"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { env, execPath, platform } from "node:process"

interface PackageManifest {
  readonly bin: Readonly<Record<string, string>>
  readonly dependencies: Readonly<Record<string, string>>
  readonly files: readonly string[]
  readonly peerDependencies: Readonly<Record<string, string>>
  readonly publishConfig: {
    readonly access: string
    readonly registry: string
  }
  readonly version: string
}

interface PackResult {
  readonly filename: string
  readonly files: readonly {
    readonly mode: number
    readonly path: string
  }[]
}

const packageDirectory = resolve(import.meta.dirname, "..")
const packageJson = JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8")) as PackageManifest
const temporaryDirectory = mkdtempSync(join(tmpdir(), "aml-cli-package-"))

function npmInvocation(args: readonly string[]): readonly [string, string[]] {
  if (env.npm_execpath !== undefined) {
    return [execPath, [env.npm_execpath, ...args]]
  }

  return [platform === "win32" ? "npm.cmd" : "npm", [...args]]
}

function runNpm(args: readonly string[], cwd: string): SpawnSyncReturns<string> {
  const [command, commandArgs] = npmInvocation(args)
  return spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    env: { ...env, NO_COLOR: "1" },
  })
}

function requireSuccess(result: SpawnSyncReturns<string>, description: string): string {
  if (result.error !== undefined) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`${description} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  return result.stdout
}

try {
  if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist", "README.md"])) {
    throw new Error('CLI package files must be exactly ["dist", "README.md"]')
  }
  if (packageJson.bin.aml !== "dist/index.js") {
    throw new Error("CLI package must expose dist/index.js as the aml executable")
  }
  if (packageJson.dependencies["@aml-jsx/sdk"] !== undefined) {
    throw new Error("CLI must not install a second private copy of @aml-jsx/sdk")
  }
  if (packageJson.peerDependencies["@aml-jsx/sdk"] !== "^0.5.0") {
    throw new Error("CLI must declare its reviewed @aml-jsx/sdk compatibility range")
  }
  if (
    packageJson.publishConfig.access !== "public" ||
    packageJson.publishConfig.registry !== "https://registry.npmjs.org/"
  ) {
    throw new Error("CLI publishConfig must target the public npm registry")
  }

  const packOutput = requireSuccess(
    runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryDirectory], packageDirectory),
    "npm pack"
  )
  const [packResult] = JSON.parse(packOutput) as PackResult[]

  if (packResult === undefined) {
    throw new Error("npm pack did not return package metadata")
  }

  const packedFiles = new Map(packResult.files.map(file => [file.path, file]))
  for (const expectedFile of [
    "README.md",
    "dist/cli.js",
    "dist/commands/run.js",
    "dist/env.js",
    "dist/index.js",
    "dist/workflow-loader.js",
    "dist/workflow-runner.js",
    "package.json",
  ]) {
    if (!packedFiles.has(expectedFile)) {
      throw new Error(`CLI package is missing ${expectedFile}`)
    }
  }

  if ([...packedFiles.keys()].some(file => file.startsWith("src/") || file.startsWith("tests/"))) {
    throw new Error("CLI package contains development source or test files")
  }

  const packedBin = packedFiles.get("dist/index.js")
  if (packedBin === undefined) {
    throw new Error("CLI package is missing dist/index.js")
  }

  // Windows npm installs a .cmd shim and does not expose a meaningful POSIX mode.
  // The installed binary is exercised below on every platform.
  if (platform !== "win32" && (packedBin.mode & 0o111) === 0) {
    throw new Error("Packed aml executable is not marked executable")
  }

  const consumerDirectory = resolve(temporaryDirectory, "consumer")
  mkdirSync(consumerDirectory)
  writeFileSync(
    resolve(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "aml-cli-package-consumer", private: true, type: "module" }, null, 2)}\n`
  )
  writeFileSync(
    resolve(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "@aml-jsx/sdk",
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ES2022",
        },
      },
      null,
      2
    )}\n`
  )

  const tarballPath = resolve(temporaryDirectory, packResult.filename)
  requireSuccess(
    runNpm(
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarballPath],
      consumerDirectory
    ),
    "installing the packed CLI"
  )

  const workflowPath = resolve(consumerDirectory, "workflow.tsx")
  writeFileSync(
    workflowPath,
    ['import { Fragment } from "@aml-jsx/sdk"', "", "export default <Fragment>packed workflow</Fragment>", ""].join(
      "\n"
    )
  )

  const binPath = resolve(consumerDirectory, "node_modules", ".bin", platform === "win32" ? "aml.cmd" : "aml")
  if (!existsSync(binPath)) {
    throw new Error(`npm did not install the aml binary at ${binPath}`)
  }

  const versionResult = spawnSync(binPath, ["--version"], {
    cwd: consumerDirectory,
    encoding: "utf8",
    shell: platform === "win32",
  })
  requireSuccess(versionResult, "running the packed CLI version command")
  if (!versionResult.stdout.startsWith(`aml/${packageJson.version} `)) {
    throw new Error(`Packed CLI reported unexpected version output: ${versionResult.stdout.trim()}`)
  }

  const workflowResult = spawnSync(binPath, ["run", workflowPath], {
    cwd: consumerDirectory,
    encoding: "utf8",
    shell: platform === "win32",
  })
  requireSuccess(workflowResult, "running a TSX workflow through the packed CLI")
  if (workflowResult.stdout !== "packed workflow\n") {
    throw new Error(`Packed CLI wrote unexpected stdout: ${JSON.stringify(workflowResult.stdout)}`)
  }
  if (!workflowResult.stderr.includes("aml: starting run") || !workflowResult.stderr.includes("(ok)")) {
    throw new Error("Packed CLI did not preserve lifecycle diagnostics on stderr")
  }

  console.log("CLI packed install, executable, version, TSX runtime, and output channels are valid")
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true })
}
