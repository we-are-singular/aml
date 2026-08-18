import { execFileSync } from "node:child_process"
import process from "node:process"

type ReleaseLane = "cli" | "sandbox" | "sdk"

interface Commit {
  readonly hash: string
  readonly subject: string
}

const sdkScopeRoots = [
  "agent",
  "context",
  "evaluate",
  "follow-up",
  "loop",
  "mcp",
  "observability",
  "provider",
  "runtime",
  "sandbox",
  "sdk",
  "skill",
  "tool",
  "workspace",
] as const

const sandboxScopes = ["agent-sandbox", "docker", "sandbox"] as const

function isReleaseLane(value: string | undefined): value is ReleaseLane {
  return value === "cli" || value === "sandbox" || value === "sdk"
}

function belongsToLane(scope: string, lane: ReleaseLane): boolean {
  if (lane === "cli") {
    return scope === "cli"
  }

  if (lane === "sandbox") {
    return sandboxScopes.includes(scope as (typeof sandboxScopes)[number])
  }

  return sdkScopeRoots.some(root => scope === root || scope.startsWith(`${root}-`))
}

function parseCommit(line: string, lane: ReleaseLane): Commit | undefined {
  const separator = line.indexOf("\0")
  if (separator < 1) {
    return undefined
  }

  const hash = line.slice(0, separator)
  const subject = line.slice(separator + 1)
  const match = /^(?:[a-z][a-z0-9-]*)\(([^)]+)\)!?:\s+.+$/.exec(subject)
  const scope = match?.[1]

  if (scope === undefined || !belongsToLane(scope, lane)) {
    return undefined
  }

  return { hash, subject }
}

function releaseNotes(lane: ReleaseLane, from: string, to: string): string {
  const log = execFileSync("git", ["log", "--no-merges", "--format=%h%x00%s", `${from}..${to}`], {
    encoding: "utf8",
  })

  return log
    .split("\n")
    .map(line => parseCommit(line, lane))
    .filter(commit => commit !== undefined)
    .map(commit => `* ${commit.subject} (${commit.hash})`)
    .join("\n")
}

const [lane, from, to = "HEAD"] = process.argv.slice(2)

if (!isReleaseLane(lane) || from === undefined) {
  process.stderr.write("Usage: node scripts/release-notes.ts <cli|sandbox|sdk> <from> [to]\n")
  process.exitCode = 1
} else {
  process.stdout.write(releaseNotes(lane, from, to))
}
