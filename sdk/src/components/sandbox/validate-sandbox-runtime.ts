import path from "node:path"

import type {
  SandboxExecOptions,
  SandboxExecResult,
  SandboxFileOptions,
  SandboxFileStaging,
  SandboxFileStat,
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
  let createFileStaging: unknown
  let cwd: unknown
  let exec: unknown
  let readFile: unknown
  let root: unknown
  let spawn: unknown
  let stat: unknown
  let writeFile: unknown

  try {
    access = candidate.access
    createFileStaging = candidate.createFileStaging
    cwd = candidate.cwd
    exec = candidate.exec
    readFile = candidate.readFile
    root = candidate.root
    spawn = candidate.spawn
    stat = candidate.stat
    writeFile = candidate.writeFile
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

  if (typeof createFileStaging !== "function") {
    throw new TypeError(`Sandbox provider "${providerName}" returned a runtime without createFileStaging()`)
  }

  if (typeof readFile !== "function") {
    throw new TypeError(`Sandbox provider "${providerName}" returned a runtime without readFile()`)
  }

  if (typeof stat !== "function") {
    throw new TypeError(`Sandbox provider "${providerName}" returned a runtime without stat()`)
  }

  if (typeof writeFile !== "function") {
    throw new TypeError(`Sandbox provider "${providerName}" returned a runtime without writeFile()`)
  }

  const runtime: SandboxRuntime = {
    access,
    createFileStaging: async (options?: Readonly<SandboxFileOptions>): Promise<Readonly<SandboxFileStaging>> => {
      const staging = await Reflect.apply(createFileStaging, value, [options])
      return validateSandboxFileStaging(staging, providerName)
    },
    cwd,
    exec: async (
      command: string,
      args?: readonly string[],
      options?: Readonly<SandboxExecOptions>
    ): Promise<Readonly<SandboxExecResult>> => {
      const result = await Reflect.apply(exec, value, [command, args, options])
      return validateSandboxExecResult(result, providerName)
    },
    readFile: async (path: string, options?: Readonly<SandboxFileOptions>): Promise<Uint8Array> => {
      assertFilePath(path, providerName, "readFile() path", false, root as string)
      const content = await Reflect.apply(readFile, value, [path, options])

      if (!(content instanceof Uint8Array)) {
        throw new TypeError(`Sandbox provider "${providerName}" returned invalid file content`)
      }

      return Uint8Array.from(content)
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
    stat: async (path: string, options?: Readonly<SandboxFileOptions>): Promise<Readonly<SandboxFileStat>> => {
      assertFilePath(path, providerName, "stat() path", true, root as string)
      const metadata = await Reflect.apply(stat, value, [path, options])
      return validateSandboxFileStat(metadata, providerName)
    },
    writeFile: async (path: string, content: Uint8Array, options?: Readonly<SandboxFileOptions>): Promise<void> => {
      assertFilePath(path, providerName, "writeFile() path", false, root as string)
      assertFileContent(content, providerName)
      await Reflect.apply(writeFile, value, [path, Uint8Array.from(content), options])
    },
  }

  return Object.freeze(runtime)
}

/** Captures one invocation-owned writable staging lease. */
function validateSandboxFileStaging(value: unknown, providerName: string): Readonly<SandboxFileStaging> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Sandbox provider "${providerName}" returned invalid file staging`)
  }

  let release: unknown
  let root: unknown
  let writeFile: unknown

  try {
    release = Reflect.get(value, "release")
    root = Reflect.get(value, "root")
    writeFile = Reflect.get(value, "writeFile")
  } catch (cause) {
    throw new TypeError(`Sandbox provider "${providerName}" returned unreadable file staging`, { cause })
  }

  if (typeof root !== "string" || root.length === 0 || root !== root.trim() || root.includes("\0")) {
    throw new TypeError(`Sandbox provider "${providerName}" returned file staging with invalid root`)
  }

  if (typeof writeFile !== "function" || typeof release !== "function") {
    throw new TypeError(`Sandbox provider "${providerName}" returned invalid file staging`)
  }

  let releasePromise: Promise<void> | undefined

  return Object.freeze({
    release: () =>
      (releasePromise ??= Promise.resolve().then(async () => {
        await Reflect.apply(release, value, [])
      })),
    root,
    writeFile: async (path: string, content: Uint8Array, options?: Readonly<SandboxFileOptions>): Promise<void> => {
      assertFilePath(path, providerName, "staging writeFile() path", false, ".")
      assertFileContent(content, providerName)
      await Reflect.apply(writeFile, value, [path, Uint8Array.from(content), options])
    },
  })
}

function validateSandboxFileStat(value: unknown, providerName: string): Readonly<SandboxFileStat> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Sandbox provider "${providerName}" returned invalid file metadata`)
  }

  let kind: unknown
  let modifiedAtMs: unknown
  let size: unknown

  try {
    kind = Reflect.get(value, "kind")
    modifiedAtMs = Reflect.get(value, "modifiedAtMs")
    size = Reflect.get(value, "size")
  } catch (cause) {
    throw new TypeError(`Sandbox provider "${providerName}" returned unreadable file metadata`, { cause })
  }

  if (
    (kind !== "directory" && kind !== "file") ||
    (modifiedAtMs !== undefined && (!Number.isFinite(modifiedAtMs) || (modifiedAtMs as number) < 0)) ||
    !Number.isSafeInteger(size) ||
    (size as number) < 0
  ) {
    throw new TypeError(`Sandbox provider "${providerName}" returned invalid file metadata`)
  }

  return Object.freeze({
    kind,
    ...(modifiedAtMs === undefined ? {} : { modifiedAtMs: modifiedAtMs as number }),
    size: size as number,
  })
}

function assertFileContent(value: unknown, providerName: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Sandbox provider "${providerName}" file content must be a Uint8Array`)
  }
}

function assertFilePath(
  value: unknown,
  providerName: string,
  field: string,
  allowRoot: boolean,
  root: string
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/")
  ) {
    throw new TypeError(`Sandbox provider "${providerName}" ${field} must be a normalized relative path`)
  }

  const segments = value.split("/")
  const normalized = path.posix.normalize(value)
  const relative = path.posix.relative(root, normalized)

  if (
    segments.includes("..") ||
    path.posix.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith("../") ||
    (!allowRoot && relative === "")
  ) {
    throw new TypeError(`Sandbox provider "${providerName}" ${field} must remain beneath its root`)
  }
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
