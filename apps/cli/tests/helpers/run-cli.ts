import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { resolve } from "node:path"
import { env as processEnv, execPath } from "node:process"

const cliEntry = resolve(import.meta.dirname, "../../dist/index.js")

interface RunCliOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
}

export function runCli(args: readonly string[], options: RunCliOptions = {}): SpawnSyncReturns<string> {
  return spawnSync(execPath, [cliEntry, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...processEnv,
      NO_COLOR: "1",
      ...options.env,
    },
    timeout: 30_000,
  })
}
