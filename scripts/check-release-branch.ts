import { execFileSync } from "node:child_process"
import process from "node:process"

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim()
}

const branch = git("branch", "--show-current")
const upstream = git("rev-parse", "--abbrev-ref", "@{upstream}")
const localCommit = git("rev-parse", "HEAD")
const upstreamCommit = git("rev-parse", "@{upstream}")

if (localCommit !== upstreamCommit) {
  process.stderr.write(
    `Release branch ${branch} must match ${upstream}. Push and verify source commits before publishing a package.\n`
  )
  process.exitCode = 1
}
