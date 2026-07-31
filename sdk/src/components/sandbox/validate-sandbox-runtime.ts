import type {
  SandboxExecOptions,
  SandboxExecResult,
  SandboxProcess,
  SandboxProcessExit,
  SandboxRuntime,
} from "./sandbox-runtime.js"

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
  let spawn: unknown

  try {
    access = candidate.access
    cwd = candidate.cwd
    exec = candidate.exec
    root = candidate.root
    spawn = candidate.spawn
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

  if (typeof spawn !== "function") {
    throw new TypeError(`Sandbox provider "${providerName}" returned a runtime without spawn()`)
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
    spawn: async (
      command: string,
      args?: readonly string[],
      options?: Readonly<SandboxExecOptions>
    ): Promise<Readonly<SandboxProcess>> => {
      const process = await Reflect.apply(spawn, value, [command, args, options])
      return validateSandboxProcess(process, providerName)
    },
  }

  return Object.freeze(runtime)
}

/**
 * Captures one provider-owned process handle before it crosses into an Agent.
 */
function validateSandboxProcess(value: unknown, providerName: string): Readonly<SandboxProcess> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Sandbox provider "${providerName}" returned an invalid process`)
  }

  let id: unknown
  let stdin: unknown
  let stderr: unknown
  let stdout: unknown
  let kill: unknown
  let wait: unknown

  try {
    id = Reflect.get(value, "id")
    stdin = Reflect.get(value, "stdin")
    stderr = Reflect.get(value, "stderr")
    stdout = Reflect.get(value, "stdout")
    kill = Reflect.get(value, "kill")
    wait = Reflect.get(value, "wait")
  } catch (cause) {
    throw new TypeError(`Sandbox provider "${providerName}" returned an unreadable process`, { cause })
  }

  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id !== id.trim() ||
    !(stdin instanceof WritableStream) ||
    !(stderr instanceof ReadableStream) ||
    !(stdout instanceof ReadableStream) ||
    typeof kill !== "function" ||
    typeof wait !== "function"
  ) {
    throw new TypeError(`Sandbox provider "${providerName}" returned an invalid process`)
  }

  let killPromise: Promise<void> | undefined
  let waitPromise: Promise<Readonly<SandboxProcessExit>> | undefined

  return Object.freeze({
    id,
    kill: () => (killPromise ??= Promise.resolve().then(() => Reflect.apply(kill, value, []))),
    stdin,
    stderr,
    stdout,
    wait: () =>
      (waitPromise ??= Promise.resolve()
        .then(() => Reflect.apply(wait, value, []))
        .then(result => validateSandboxProcessExit(result, providerName))),
  })
}

function validateSandboxProcessExit(value: unknown, providerName: string): Readonly<SandboxProcessExit> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Sandbox provider "${providerName}" returned an invalid process exit`)
  }

  const exitCode = Reflect.get(value, "exitCode")

  if (!Number.isSafeInteger(exitCode)) {
    throw new TypeError(`Sandbox provider "${providerName}" returned an invalid process exit`)
  }

  return Object.freeze({ exitCode: exitCode as number })
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
