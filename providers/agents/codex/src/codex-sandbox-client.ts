import { randomUUID } from "node:crypto"

import type { SandboxSession } from "@aml-jsx/sdk"

import type {
  CodexClient,
  CodexClientOptions,
  CodexConfig,
  CodexConfigValue,
  CodexThread,
  CodexThreadOptions,
  CodexTurnOptions,
  CodexTurnResult,
} from "./codex-client-factory.js"

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/

interface CodexSandboxClientOptions extends CodexClientOptions {
  readonly sandbox: SandboxSession
}

/**
 * Runs the installed Codex CLI beside the attached Sandbox Workspace.
 *
 * This client intentionally speaks Codex's JSON CLI protocol instead of
 * attempting to forward individual model-controlled filesystem operations.
 */
export class CodexSandboxClient implements CodexClient {
  readonly #home: string
  readonly #options: CodexSandboxClientOptions
  readonly #ownsHome: boolean
  #closePromise: Promise<void> | undefined

  constructor(options: CodexSandboxClientOptions) {
    this.#options = options
    this.#ownsHome = options.env?.CODEX_HOME === undefined
    this.#home = options.env?.CODEX_HOME ?? `/tmp/aml-codex-${randomUUID()}`
  }

  startThread(options: CodexThreadOptions): CodexThread {
    return new CodexSandboxThread(this.#home, this.#options, options)
  }

  /**
   * Removes invocation-owned Codex session and schema state.
   */
  close(): Promise<void> {
    this.#closePromise ??= this.#close()
    return this.#closePromise
  }

  async #close(): Promise<void> {
    if (!this.#ownsHome) {
      return
    }

    let failure = "no command output"

    // Older Codex CLIs may finish a background plugin-cache clone just after
    // the main process exits. A bounded retry lets that child settle without
    // making Sandbox providers understand Codex-owned state.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await this.#options.sandbox.lease.runtime.exec("rm", ["-rf", "--", this.#home], {
        cwd: this.#options.sandbox.cwd,
      })

      if (result.exitCode === 0) {
        return
      }

      failure = diagnostics(result.stderr, result.stdout)
    }

    throw new Error(`Codex Sandbox cleanup failed: ${failure}`)
  }
}

class CodexSandboxThread implements CodexThread {
  readonly #clientOptions: CodexSandboxClientOptions
  readonly #home: string
  readonly #threadOptions: CodexThreadOptions
  #threadId: string | undefined

  constructor(home: string, clientOptions: CodexSandboxClientOptions, threadOptions: CodexThreadOptions) {
    this.#clientOptions = clientOptions
    this.#home = home
    this.#threadOptions = threadOptions
  }

  async run(prompt: string, options: CodexTurnOptions): Promise<CodexTurnResult> {
    options.signal.throwIfAborted()
    await this.#prepareHome(options.signal)
    const outputSchema = options.outputSchema
    const schemaPath = outputSchema === undefined ? undefined : `${this.#home}/output-schema-${randomUUID()}.json`

    if (schemaPath !== undefined && outputSchema !== undefined) {
      await this.#writeSchema(schemaPath, outputSchema, options.signal)
    }

    try {
      const result = await this.#clientOptions.sandbox.lease.runtime.exec(
        this.#clientOptions.codexPathOverride ?? "codex",
        this.#args(prompt, schemaPath),
        {
          cwd: this.#clientOptions.sandbox.cwd,
          env: this.#environment(),
          signal: options.signal,
        }
      )

      if (result.exitCode !== 0) {
        throw new Error(
          `Codex Sandbox CLI exited with code ${result.exitCode}: ${diagnostics(result.stderr, result.stdout)}`
        )
      }

      const turn = parseCodexJson(result.stdout)
      this.#threadId = turn.threadId
      return Object.freeze({ finalResponse: turn.finalResponse })
    } finally {
      if (schemaPath !== undefined) {
        await this.#removeSchema(schemaPath)
      }
    }
  }

  #args(prompt: string, schemaPath: string | undefined): string[] {
    const args = ["exec", "--json", "--color", "never", "--ignore-rules"]

    for (const override of serializeConfigOverrides(this.#clientOptions.config)) {
      args.push("--config", override)
    }

    args.push("--config", `approval_policy=${JSON.stringify(this.#threadOptions.approvalPolicy)}`)
    args.push("--config", `web_search=${JSON.stringify(this.#threadOptions.webSearchMode)}`)
    args.push(
      "--config",
      `sandbox_workspace_write.network_access=${this.#threadOptions.networkAccessEnabled ? "true" : "false"}`
    )

    if (this.#clientOptions.baseUrl !== undefined) {
      args.push("--config", `openai_base_url=${JSON.stringify(this.#clientOptions.baseUrl)}`)
    }

    if (this.#threadOptions.model !== undefined) {
      args.push("--model", this.#threadOptions.model)
    }

    if (this.#threadOptions.modelReasoningEffort !== undefined) {
      args.push("--config", `model_reasoning_effort=${JSON.stringify(this.#threadOptions.modelReasoningEffort)}`)
    }

    // Codex's inner sandbox is redundant here. The selected AML Sandbox is the
    // outer execution boundary and owns the writable Workspace attachment.
    args.push("--sandbox", this.#clientOptions.sandbox.access === "read-write" ? "danger-full-access" : "read-only")

    if (this.#threadOptions.skipGitRepoCheck) {
      args.push("--skip-git-repo-check")
    }

    if (schemaPath !== undefined) {
      args.push("--output-schema", schemaPath)
    }

    if (this.#threadId !== undefined) {
      args.push("resume", this.#threadId, "--", prompt)
    } else {
      args.push("--", prompt)
    }

    return args
  }

  #environment(): Readonly<Record<string, string>> {
    return Object.freeze({
      ...this.#clientOptions.env,
      ...(this.#clientOptions.env?.CODEX_HOME === undefined ? { CODEX_HOME: this.#home } : {}),
      ...(this.#clientOptions.apiKey === undefined ? {} : { CODEX_API_KEY: this.#clientOptions.apiKey }),
    })
  }

  async #prepareHome(signal: AbortSignal): Promise<void> {
    const result = await this.#clientOptions.sandbox.lease.runtime.exec("mkdir", ["-p", "--", this.#home], {
      cwd: this.#clientOptions.sandbox.cwd,
      signal,
    })

    if (result.exitCode !== 0) {
      throw new Error(`Codex Sandbox state setup failed: ${diagnostics(result.stderr, result.stdout)}`)
    }
  }

  async #writeSchema(
    schemaPath: string,
    schema: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ): Promise<void> {
    const result = await this.#clientOptions.sandbox.lease.runtime.exec(
      "node",
      [
        "-e",
        "require('node:fs').mkdirSync(require('node:path').dirname(process.argv[1]),{recursive:true});require('node:fs').writeFileSync(process.argv[1],process.argv[2])",
        schemaPath,
        JSON.stringify(schema),
      ],
      {
        cwd: this.#clientOptions.sandbox.cwd,
        signal,
      }
    )

    if (result.exitCode !== 0) {
      throw new Error(`Codex Sandbox output schema setup failed: ${diagnostics(result.stderr, result.stdout)}`)
    }
  }

  async #removeSchema(schemaPath: string): Promise<void> {
    const result = await this.#clientOptions.sandbox.lease.runtime.exec("rm", ["-f", "--", schemaPath], {
      cwd: this.#clientOptions.sandbox.cwd,
    })

    if (result.exitCode !== 0) {
      throw new Error(`Codex Sandbox output schema cleanup failed: ${diagnostics(result.stderr, result.stdout)}`)
    }
  }
}

interface ParsedCodexTurn {
  readonly finalResponse: string
  readonly threadId: string
}

function parseCodexJson(output: string): Readonly<ParsedCodexTurn> {
  let finalResponse = ""
  let threadId: string | undefined
  let failure: string | undefined
  const diagnostics: string[] = []

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (trimmed.length === 0) {
      continue
    }

    let event: unknown

    try {
      event = JSON.parse(trimmed)
    } catch (cause) {
      // Some remote command APIs combine stdout and stderr. Preserve Codex's
      // diagnostic lines without treating them as JSON protocol events.
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        diagnostics.push(trimmed)
        continue
      }

      throw new Error(`Codex Sandbox CLI returned invalid JSON: ${line}`, { cause })
    }

    if (typeof event !== "object" || event === null) {
      throw new TypeError("Codex Sandbox CLI returned an invalid event")
    }

    const type = Reflect.get(event, "type")

    if (type === "thread.started") {
      const value = Reflect.get(event, "thread_id")

      if (typeof value !== "string" || value.length === 0) {
        throw new TypeError("Codex Sandbox CLI returned an invalid thread id")
      }

      threadId = value
      continue
    }

    if (type === "item.completed") {
      const item = Reflect.get(event, "item")

      if (
        typeof item === "object" &&
        item !== null &&
        Reflect.get(item, "type") === "agent_message" &&
        typeof Reflect.get(item, "text") === "string"
      ) {
        finalResponse = Reflect.get(item, "text") as string
      }
      continue
    }

    if (type === "turn.failed") {
      const error = Reflect.get(event, "error")
      failure =
        typeof error === "object" && error !== null && typeof Reflect.get(error, "message") === "string"
          ? (Reflect.get(error, "message") as string)
          : "Codex turn failed"
      continue
    }
  }

  if (failure !== undefined) {
    throw new Error(`Codex Sandbox CLI failed: ${failure}`)
  }

  if (threadId === undefined) {
    const detail = diagnostics.length === 0 ? "" : `: ${diagnostics.join("\n")}`
    throw new Error(`Codex Sandbox CLI returned no thread id${detail}`)
  }

  return Object.freeze({ finalResponse, threadId })
}

/**
 * Mirrors the official SDK's dotted `--config` serialization so configured
 * Codex factories retain their native config shape in a remote CLI process.
 */
function serializeConfigOverrides(config: CodexConfig): string[] {
  const overrides: string[] = []
  flattenConfigOverrides(config, "", overrides)
  return overrides
}

function flattenConfigOverrides(value: CodexConfig, prefix: string, overrides: string[]): void {
  const entries = Object.entries(value)

  if (prefix.length > 0 && entries.length === 0) {
    overrides.push(`${prefix}={}`)
    return
  }

  for (const [key, child] of entries) {
    const configPath = prefix.length === 0 ? key : `${prefix}.${key}`

    if (typeof child === "object" && child !== null && !Array.isArray(child)) {
      // Array.isArray does not narrow readonly arrays from this recursive
      // config union, but the runtime branch established a config table.
      flattenConfigOverrides(child as CodexConfig, configPath, overrides)
    } else {
      overrides.push(`${configPath}=${toTomlValue(child, configPath)}`)
    }
  }
}

function toTomlValue(value: CodexConfigValue, configPath: string): string {
  if (typeof value === "string") {
    return JSON.stringify(value)
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Codex config override at ${configPath} must be finite`)
    }

    return String(value)
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false"
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => toTomlValue(entry, `${configPath}[${index}]`)).join(", ")}]`
  }

  return `{${Object.entries(value)
    .map(
      ([key, entry]) =>
        `${TOML_BARE_KEY.test(key) ? key : JSON.stringify(key)} = ${toTomlValue(entry, `${configPath}.${key}`)}`
    )
    .join(", ")}}`
}

function diagnostics(stderr: string, stdout: string): string {
  const output = [stderr.trim(), stdout.trim()].filter(value => value.length > 0)
  return output.length === 0 ? "no command output" : output.join("\n")
}
