import path from "node:path"

import type { SandboxAcquireRequest } from "./sandbox-provider.js"
import type { SandboxExecOptions } from "./sandbox-runtime.js"

/**
 * Captured and validated provider-neutral Sandbox command.
 */
export class SandboxCommand {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly signal: AbortSignal
  readonly timeoutMs: number | undefined

  private constructor(input: {
    readonly args: readonly string[]
    readonly command: string
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly signal: AbortSignal
    readonly timeoutMs?: number
  }) {
    this.args = input.args
    this.command = input.command
    this.cwd = input.cwd
    this.env = input.env
    this.signal = input.signal
    this.timeoutMs = input.timeoutMs
    Object.freeze(this)
  }

  /**
   * Captures one runtime call without trusting mutable caller-owned values.
   */
  static from(
    request: SandboxAcquireRequest,
    command: unknown,
    args: unknown = [],
    options: unknown = {}
  ): SandboxCommand {
    if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
      throw new TypeError("Sandbox command must be a non-empty string without null bytes")
    }

    if (!Array.isArray(args) || args.some(argument => typeof argument !== "string" || argument.includes("\0"))) {
      throw new TypeError("Sandbox command arguments must be strings without null bytes")
    }

    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("Sandbox command options must be an object")
    }

    const captured = options as SandboxExecOptions
    const cwd = validateCwd(captured.cwd ?? request.cwd, request.root)
    const env = captureEnvironment(captured.env)
    const signal = captured.signal ?? request.signal
    const timeoutMs = validateTimeout(captured.timeoutMs)
    signal.throwIfAborted()

    return new SandboxCommand({
      args: Object.freeze([...args]),
      command,
      cwd,
      env,
      signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    })
  }
}

function validateCwd(value: unknown, root: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.split("/").includes("..")
  ) {
    throw new TypeError("Sandbox command cwd must be a normalized relative forward-slash path")
  }

  const cwd = path.posix.normalize(value)
  const relative = path.posix.relative(root, cwd)

  if (path.posix.isAbsolute(relative) || relative === ".." || relative.startsWith("../")) {
    throw new TypeError("Sandbox command cwd resolves outside its configured root")
  }

  return cwd
}

function captureEnvironment(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) {
    return Object.freeze({})
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Sandbox command environment must be an object")
  }

  const result: Record<string, string> = {}

  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== "string" || entry.includes("\0")) {
      throw new TypeError("Sandbox command environment contains an invalid entry")
    }

    result[key] = entry
  }

  return Object.freeze(result)
}

function validateTimeout(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 2_147_483_647) {
    throw new RangeError("Sandbox command timeoutMs must be a positive timer-safe integer")
  }

  return value as number
}
