// Installs the shared npm toolchain and patches its separately bundled dependencies.
import { execFileSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import process from "node:process"

const npmVersion = "12.2.1"
const ipAddressVersion = "10.7.4"
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
  // npm 12.2.1 bundles vulnerable ip-address 10.7.2. Installing into npm's own
  // package also resolves its unpublished development dependencies, so stage the leaf separately.
  execFileSync(
    process.execPath,
    [
      join(npmDirectory, "bin/npm-cli.js"),
      "install",
      "--prefix",
      stagingDirectory,
      "--ignore-scripts",
      "--no-save",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
      `ip-address@${ipAddressVersion}`,
    ],
    { stdio: "inherit" }
  )
  const target = join(npmDirectory, "node_modules/ip-address")
  rmSync(target, { force: true, recursive: true })
  cpSync(join(stagingDirectory, "node_modules/ip-address"), target, { recursive: true })
  const installed = JSON.parse(readFileSync(join(target, "package.json"), "utf8"))
  if (installed.version !== ipAddressVersion) throw new Error("npm's bundled ip-address patch was not installed")
} finally {
  rmSync(stagingDirectory, { force: true, recursive: true })
}

process.stdout.write(`Installed npm ${npmVersion} with bundled ip-address ${ipAddressVersion}\n`)
