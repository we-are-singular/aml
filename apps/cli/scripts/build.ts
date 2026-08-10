import { execFileSync } from "node:child_process"
import { chmodSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { execPath, platform } from "node:process"
import { fileURLToPath } from "node:url"

const packageDirectory = resolve(import.meta.dirname, "..")
const outputDirectory = resolve(packageDirectory, "dist")
const typescriptModule = fileURLToPath(import.meta.resolve("typescript"))
const typescriptCli = resolve(dirname(typescriptModule), "tsc.js")

// A clean package build cannot accidentally ship files from an older output shape.
rmSync(outputDirectory, { force: true, recursive: true })
execFileSync(
  execPath,
  [typescriptCli, "-p", resolve(packageDirectory, "tsconfig.build.json"), "--outDir", outputDirectory],
  {
    cwd: packageDirectory,
    stdio: "inherit",
  }
)

if (platform !== "win32") {
  chmodSync(resolve(outputDirectory, "index.js"), 0o755)
}
