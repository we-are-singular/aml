import type { SandboxExecOptions, SandboxExecResult, SandboxRuntime } from "./sandbox-runtime.js"

/**
 * Validates and captures the minimal runtime returned by a Sandbox provider.
 */
export function validateSandboxRuntime(value: unknown, providerName: string): Readonly<SandboxRuntime> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Sandbox provider "${providerName}" returned an invalid runtime`)
  }

  const candidate = value as Partial<Record<keyof SandboxRuntime, unknown>>
  let access: unknown
  let cwd: unknown
  let exec: unknown
  let root: unknown

  try {
    access = candidate.access
    cwd = candidate.cwd
    exec = candidate.exec
    root = candidate.root
  } catch (cause) {
    throw new TypeError(`Sandbox provider "${providerName}" returned an unreadable runtime`, { cause })
  }

  if (access !== "read-only" && access !== "read-write") {
    throw new TypeError(`Sandbox provider "${providerName}" returned a runtime with invalid access`)
  }

  assertLogicalPath(cwd, providerName, "cwd")
  assertLogicalPath(root, providerName, "root")

  if (typeof exec !== "function") {
    throw new TypeError(`Sandbox provider "${providerName}" returned a runtime without exec()`)
  }

  const runtime: SandboxRuntime = {
    access,
    cwd,
    exec: async (
      command: string,
      args?: readonly string[],
      options?: Readonly<SandboxExecOptions>
    ): Promise<Readonly<SandboxExecResult>> => {
      const result = await Reflect.apply(exec, value, [command, args, options])
      return validateSandboxExecResult(result, providerName)
    },
    root,
  }

  return Object.freeze(runtime)
}

/**
 * Captures one provider-owned command result before it crosses into an Agent.
 */
function validateSandboxExecResult(value: unknown, providerName: string): Readonly<SandboxExecResult> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Sandbox provider "${providerName}" returned an invalid command result`)
  }

  let exitCode: unknown
  let stderr: unknown
  let stdout: unknown

  try {
    exitCode = Reflect.get(value, "exitCode")
    stderr = Reflect.get(value, "stderr")
    stdout = Reflect.get(value, "stdout")
  } catch (cause) {
    throw new TypeError(`Sandbox provider "${providerName}" returned an unreadable command result`, { cause })
  }

  if (!Number.isSafeInteger(exitCode) || typeof stderr !== "string" || typeof stdout !== "string") {
    throw new TypeError(`Sandbox provider "${providerName}" returned an invalid command result`)
  }

  return Object.freeze({
    exitCode: exitCode as number,
    stderr,
    stdout,
  })
}

function assertLogicalPath(value: unknown, providerName: string, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`Sandbox provider "${providerName}" returned a runtime with invalid ${field}`)
  }
}
