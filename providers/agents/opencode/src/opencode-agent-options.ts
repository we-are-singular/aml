import type { Config } from "@opencode-ai/sdk/v2"

/**
 * Configures the OpenCode ACP profile without selecting another lifecycle.
 */
export interface OpenCodeAgentOptions {
  readonly args?: readonly string[]
  readonly command?: string
  readonly config?: Config
  readonly directory?: string
  readonly env?: Readonly<Record<string, string>>
  readonly model?: string
}

/**
 * Immutable OpenCode ACP configuration captured by the public factory.
 */
export interface CapturedOpenCodeAgentOptions {
  readonly args: readonly string[]
  readonly command: string
  readonly config: Readonly<Config>
  readonly directory?: string
  readonly env: Readonly<Record<string, string>>
  readonly model?: string
}

/**
 * Validates configuration before any host or Sandbox process starts.
 */
export function captureOpenCodeAgentOptions(options: OpenCodeAgentOptions): Readonly<CapturedOpenCodeAgentOptions> {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("OpenCode Agent options must be an object")
  }

  const args = options.args ?? []
  const command = normalizedString(options.command ?? "opencode", "OpenCode command")
  const config = options.config ?? {}
  const directory = options.directory
  const env = options.env ?? {}
  const model = options.model

  if (!Array.isArray(args) || args.some(argument => typeof argument !== "string" || argument.includes("\0"))) {
    throw new TypeError("OpenCode args must be strings without null bytes")
  }

  if (directory !== undefined) {
    normalizedString(directory, "OpenCode directory")
  }

  if (model !== undefined) {
    normalizedString(model, "OpenCode model")
  }

  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new TypeError("OpenCode env must be an object")
  }

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new TypeError("OpenCode config must be an object")
  }

  const capturedConfig = captureJson(config, "OpenCode config") as Readonly<Config>

  return Object.freeze({
    args: Object.freeze([...args]),
    command,
    config: capturedConfig,
    ...(directory === undefined ? {} : { directory }),
    env: Object.freeze({ ...env }),
    ...(model === undefined ? {} : { model }),
  })
}

function captureJson(value: unknown, label: string, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label} must contain only finite JSON numbers`)
    }

    return value
  }

  if (typeof value !== "object") {
    throw new TypeError(`${label} must contain only JSON values`)
  }

  if (seen.has(value)) {
    throw new TypeError(`${label} must not contain cycles`)
  }

  seen.add(value)

  if (Array.isArray(value)) {
    const captured = value.map(item => captureJson(item, label, seen))
    seen.delete(value)
    return Object.freeze(captured)
  }

  const captured: Record<string, unknown> = {}

  for (const key of Object.keys(value)) {
    captured[key] = captureJson(Reflect.get(value, key), label, seen)
  }

  seen.delete(value)
  return Object.freeze(captured)
}

function normalizedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty normalized string`)
  }

  return value
}
