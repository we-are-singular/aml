import type { OpenCodeConfig } from "./opencode-config.js"

/**
 * Configures the OpenCode ACP profile without selecting another lifecycle.
 */
export interface OpenCodeAgentOptions {
  /**
   * Arguments appended after AML's `acp --pure --cwd <cwd>` arguments.
   *
   * Defaults to `[]`; entries cannot contain null bytes.
   */
  readonly args?: readonly string[]

  /**
   * OpenCode executable or application-owned launcher.
   *
   * Defaults to `"opencode"`. AML does not install OpenCode.
   */
  readonly command?: string

  /**
   * Native OpenCode configuration captured before external work begins.
   *
   * Defaults to `{}` and must contain only finite, acyclic JSON values. AML
   * preserves native settings, then applies its generated Agent profile,
   * effective model, Tool configuration, and permission denials.
   */
  readonly config?: OpenCodeConfig

  /**
   * Fallback launch directory when no active Sandbox supplies one.
   *
   * Omit to use the application working directory.
   */
  readonly directory?: string

  /**
   * Additional environment variables for credentials and provider settings.
   *
   * Defaults to `{}`. AML writes invocation-private OpenCode state variables
   * afterward; only an explicit `XDG_DATA_HOME` is intentionally preserved.
   */
  readonly env?: Readonly<Record<string, string>>

  /**
   * Provider-level model fallback.
   *
   * Precedence is `<Agent model>`, this option, then `config.model`, followed by
   * OpenCode's own default.
   */
  readonly model?: string
}

/**
 * Immutable OpenCode ACP configuration captured by the public factory.
 */
export interface CapturedOpenCodeAgentOptions {
  readonly args: readonly string[]
  readonly command: string
  readonly config: Readonly<OpenCodeConfig>
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

  const capturedConfig = captureJson(config, "OpenCode config") as Readonly<OpenCodeConfig>

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
