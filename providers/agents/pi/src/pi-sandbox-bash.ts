import { createBashToolDefinition, type BashOperations, type ToolDefinition } from "@earendil-works/pi-coding-agent"

import type { PiSessionCreateInput } from "./pi-session-client.js"

/**
 * Rebuilds Pi's native bash tool over the common AML execution runtime.
 *
 * The first narrow runtime intentionally supports only this complete shell
 * capability. Other Pi filesystem tools fail instead of touching the host.
 */
export function createPiSandboxTools(
  names: readonly string[],
  sandbox: NonNullable<PiSessionCreateInput["sandbox"]>
): readonly ToolDefinition[] {
  return Object.freeze(
    names.map(name => {
      if (name !== "bash") {
        throw new Error(`Pi host Tool "${name}" is not supported by the narrow Sandbox runtime`)
      }

      return createBashToolDefinition(sandbox.cwd, {
        exposeSessionEnvironment: false,
        operations: createBashOperations(sandbox),
      }) as ToolDefinition
    })
  )
}

function createBashOperations(sandbox: NonNullable<PiSessionCreateInput["sandbox"]>): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      const result = await sandbox.runtime.exec("sh", ["-lc", command], {
        cwd,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout * 1_000 }),
      })

      if (result.stdout.length > 0) {
        options.onData(Buffer.from(result.stdout))
      }

      if (result.stderr.length > 0) {
        options.onData(Buffer.from(result.stderr))
      }

      return { exitCode: result.exitCode }
    },
  }
}
