// Runs `npm audit` in the current directory and fails on every advisory that
// scripts/npm-audit-allowlist.json does not explicitly accept. Arguments are
// forwarded to npm, for example `--omit=dev`.
import { execFileSync } from "node:child_process"
import console from "node:console"
import { readFileSync } from "node:fs"
import process from "node:process"
import { URL } from "node:url"

const allowlist = JSON.parse(readFileSync(new URL("npm-audit-allowlist.json", import.meta.url), "utf8"))
const accepted = new Map(allowlist.advisories.map(advisory => [advisory.id, advisory]))

const report = JSON.parse(runAudit(process.argv.slice(2)))
if (report.error !== undefined) {
  throw new Error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`)
}

const found = new Map()
for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via) {
    // String entries point at another vulnerable package; its own entry lists the advisory.
    if (typeof via === "string") continue
    const id = via.url?.split("/").pop() ?? `npm-${via.source}`
    const advisory = found.get(id) ?? { packages: new Set(), severity: via.severity, title: via.title }
    advisory.packages.add(via.name)
    found.set(id, advisory)
  }
}

const unexpected = [...found].filter(([id]) => !accepted.has(id))
for (const [id, advisory] of found) {
  const status = accepted.has(id) ? "accepted" : "FAILED"
  console.log(`${status} ${id} ${advisory.severity} ${[...advisory.packages].join(", ")}: ${advisory.title}`)
}

if (unexpected.length > 0) {
  console.error(
    `\n${unexpected.length} npm audit ${unexpected.length === 1 ? "advisory is" : "advisories are"} not accepted. ` +
      "Upgrade the affected dependency, or add a reviewed entry to scripts/npm-audit-allowlist.json."
  )
  process.exitCode = 1
} else {
  console.log(`\nnpm audit passed: ${found.size} accepted ${found.size === 1 ? "advisory" : "advisories"}.`)
}

function runAudit(args) {
  try {
    return execFileSync("npm", ["audit", "--json", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    // npm audit exits non-zero whenever it finds advisories; the JSON report is still complete.
    if (typeof error.stdout === "string" && error.stdout.trim().startsWith("{")) return error.stdout
    throw error
  }
}
