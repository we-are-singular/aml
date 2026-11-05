// Installs the shared npm toolchain and patches its separately bundled dependencies.
import { execFileSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import process from "node:process"

const npmVersion = "12.2.2"
const ipAddressVersion = "10.7.5"
const bundledPatches = { glob: "14.0.2", minimatch: "11.0.3" }
const args = process.argv.slice(2)
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--prefix" || !args[1])) {
  throw new Error("Usage: node install-npm.mjs [--prefix <directory>]")
}

const globalArgs = ["--global", ...args]
// Invoke npm through Node so Windows never needs to spawn the npm.cmd shell shim.
const npmCli =
  process.env.npm_execpath ??
  join(
    dirname(process.execPath),
    process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "../lib/node_modules/npm/bin/npm-cli.js"
  )
execFileSync(process.execPath, [npmCli, "install", ...globalArgs, `npm@${npmVersion}`, "--no-audit", "--no-fund"], {
  stdio: "inherit",
})
const globalRoot = execFileSync(process.execPath, [npmCli, "root", ...globalArgs], { encoding: "utf8" }).trim()
const npmDirectory = join(globalRoot, "npm")
const stagingDirectory = mkdtempSync(join(tmpdir(), "aml-npm-patch-"))

try {
  // npm 12.2.2 still bundles vulnerable glob/minimatch versions. Keep each
  // replacement's dependency tree nested so npm's other bundled packages stay intact.
  execFileSync(
    process.execPath,
    [
      join(npmDirectory, "bin/npm-cli.js"),
      "install",
      "--prefix",
      stagingDirectory,
      "--install-strategy=nested",
      "--ignore-scripts",
      "--no-save",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
      ...Object.entries(bundledPatches).map(([name, version]) => `${name}@${version}`),
    ],
    { stdio: "inherit" }
  )
  for (const [name, version] of Object.entries(bundledPatches)) {
    const source = join(stagingDirectory, "node_modules", name)
    const installed = JSON.parse(readFileSync(join(source, "package.json"), "utf8"))
    if (installed.version !== version) throw new Error(`npm's bundled ${name} patch was not staged`)
    const target = join(npmDirectory, "node_modules", name)
    rmSync(target, { force: true, recursive: true })
    cpSync(source, target, { recursive: true })
  }
} finally {
  rmSync(stagingDirectory, { force: true, recursive: true })
}
// npm carries dependencies outside the project lockfile. Version 12.2.2 bundles
// the patched leaf itself, so verify it instead of replacing npm's package files.
const installed = JSON.parse(readFileSync(join(npmDirectory, "node_modules/ip-address/package.json"), "utf8"))
if (installed.version !== ipAddressVersion)
  throw new Error("npm's bundled ip-address version is not the expected patch")

process.stdout.write(`Installed npm ${npmVersion} with bundled ip-address ${ipAddressVersion}\n`)
process.stdout.write(`Patched npm's bundled glob ${bundledPatches.glob} and minimatch ${bundledPatches.minimatch}\n`)
