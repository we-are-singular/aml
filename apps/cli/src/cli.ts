import { readFileSync } from "node:fs"
import { stderr, stdout } from "node:process"
import type { Writable } from "node:stream"
import { URL } from "node:url"

import { cac, type CAC } from "cac"

import { registerRunCommand } from "./commands/run.js"

interface PackageManifest {
  readonly version: string
}

export interface CliIo {
  readonly stderr: Writable
  readonly stdout: Writable
}

const defaultIo: CliIo = { stderr, stdout }
const packageManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest

/** Creates the declarative AML command surface without executing it. */
export function createCli(io: CliIo = defaultIo): CAC {
  const cli = cac("aml")

  cli.help()
  cli.version(packageManifest.version)
  registerRunCommand(cli, io)

  return cli
}

/** Parses and executes one AML command without terminating the host process. */
export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const cli = createCli(io)

  try {
    cli.parse(argv, { run: false })

    if (cli.options.help || cli.options.version) {
      return 0
    }

    if (cli.matchedCommand === undefined) {
      if (cli.args.length === 0) {
        cli.outputHelp()
        return 0
      }

      throw new Error(`unknown command: ${String(cli.args[0])}`)
    }

    const exitCode = await cli.runMatchedCommand()
    return typeof exitCode === "number" ? exitCode : 0
  } catch (error) {
    io.stderr.write(`aml: ${formatCliError(error)}\n`)
    return 1
  }
}

/** Preserves provider diagnostics hidden behind AML's contextual error wrappers. */
function formatCliError(error: unknown): string {
  const messages: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error

  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    messages.push(current instanceof Error ? current.message : String(current))
    current = current instanceof Error ? current.cause : undefined
  }

  return messages.join("\n  caused by: ")
}
