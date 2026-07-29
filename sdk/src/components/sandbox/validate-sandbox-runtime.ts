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
    ): Promise<Readonly<SandboxExecResult>> =>
      (await Reflect.apply(exec, value, [command, args, options])) as Readonly<SandboxExecResult>,
    root,
  }

  return Object.freeze(runtime)
}

function assertLogicalPath(value: unknown, providerName: string, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`Sandbox provider "${providerName}" returned a runtime with invalid ${field}`)
  }
}
