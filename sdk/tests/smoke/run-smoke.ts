import { fileURLToPath } from "node:url"
import path from "node:path"

import { execa } from "execa"

import { parseSmokeCommand, selectSmokeCases, SMOKE_AGENT_NAMES, SMOKE_SANDBOX_NAMES } from "./smoke-matrix.js"

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"))
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error
  }
}

/**
 * Owns CLI selection and delegates test execution to the dedicated smoke
 * configuration so application flags never collide with Vitest flags.
 */
async function main(): Promise<void> {
  const command = parseSmokeCommand(process.argv.slice(2))

  if (command.kind === "help") {
    console.log(
      [
        "Usage: npm run smoke -- [--agent <name>] [--sandbox <name>] [--list]",
        "",
        `Agents: ${SMOKE_AGENT_NAMES.join(", ")}`,
        `Sandboxes: ${SMOKE_SANDBOX_NAMES.join(", ")}`,
        "",
        "Omitted filters run the complete Agent x Sandbox matrix.",
      ].join("\n")
    )
    return
  }

  const cases = selectSmokeCases(command.selection)

  if (command.kind === "list") {
    console.log(cases.map(test => `${test.agent} x ${test.sandbox}`).join("\n"))
    return
  }

  console.log(`Running ${cases.length} smoke matrix ${cases.length === 1 ? "cell" : "cells"}:`)
  console.log(cases.map(test => `  ${test.agent} x ${test.sandbox}`).join("\n"))

  const sdkDirectory = path.resolve(import.meta.dirname, "../..")
  const result = await execa(
    "vitest",
    [
      "run",
      "--config",
      fileURLToPath(new URL("../../vitest.smoke.config.ts", import.meta.url)),
      "--reporter",
      "verbose",
      "--disableConsoleIntercept",
      "--no-file-parallelism",
    ],
    {
      cwd: sdkDirectory,
      env: {
        ...process.env,
        ...(command.selection.agent === undefined ? {} : { AML_SMOKE_AGENT: command.selection.agent }),
        ...(command.selection.sandbox === undefined ? {} : { AML_SMOKE_SANDBOX: command.selection.sandbox }),
      },
      reject: false,
      stdio: "inherit",
    }
  )

  process.exitCode = result.exitCode
}

await main()
