import {
  defineAcpAgentProvider,
  type AcpAgentLaunch,
  type AcpAgentLaunchContext,
  type AcpAgentProfile,
  type AgentProvider,
} from "@aml-jsx/sdk"

/**
 * Configures the maintained pi-acp adapter and underlying Pi command.
 */
export interface PiAgentOptions {
  readonly args?: readonly string[]
  readonly command?: string
  readonly env?: Readonly<Record<string, string>>
  /**
   * Path to the environment-installed pi-mcp-adapter entrypoint.
   *
   * When omitted, the launch wrapper resolves the installed package beside its
   * `pi-mcp-adapter` executable. AML never installs runtime software implicitly.
   */
  readonly mcpAdapterPath?: string
  readonly model?: string
  readonly piCommand?: string
  readonly thinkingLevel?: string
  readonly workingDirectory?: string
}

export interface PiAgentProvider extends AgentProvider {
  readonly name: "pi"
}

interface CapturedPiAgentOptions {
  readonly args: readonly string[]
  readonly command: string
  readonly env: Readonly<Record<string, string>>
  readonly mcpAdapterPath?: string
  readonly model?: string
  readonly piCommand: string
  readonly thinkingLevel?: string
  readonly workingDirectory?: string
}

class PiAcpProfile implements AcpAgentProfile<"pi"> {
  readonly name = "pi"
  readonly #options: Readonly<CapturedPiAgentOptions>

  constructor(options: Readonly<CapturedPiAgentOptions>) {
    this.#options = options
  }

  get workingDirectory(): string | undefined {
    return this.#options.workingDirectory
  }

  createLaunch(context: Readonly<AcpAgentLaunchContext>): Readonly<AcpAgentLaunch> {
    const configuration: NonNullable<AcpAgentLaunch["configuration"]>[number][] = []
    const model = context.request.model ?? this.#options.model
    const usesMcp = context.mcpServers.length > 0

    if (model !== undefined) {
      configuration.push({ category: "model", value: model })
    }

    if (this.#options.thinkingLevel !== undefined) {
      configuration.push({ category: "thought_level", value: this.#options.thinkingLevel })
    }

    const needsWrapper = usesMcp || !hasDefaultPiPermissions(context.request.permissions)
    const piCommand = needsWrapper ? `${context.stateDirectory}/pi-for-aml` : this.#options.piCommand
    return Object.freeze({
      args: this.#options.args,
      command: this.#options.command,
      configuration: Object.freeze(configuration),
      env: {
        ...this.#options.env,
        // pi-acp stores its own session map under os.homedir(). Isolate that
        // adapter-owned state alongside Pi's invocation-owned state.
        HOME: context.stateDirectory,
        PI_ACP_PI_COMMAND: piCommand,
        PI_CODING_AGENT_DIR: `${context.stateDirectory}/agent`,
        PI_CODING_AGENT_SESSION_DIR: `${context.stateDirectory}/sessions`,
        PI_SKIP_VERSION_CHECK: "1",
      },
      files: [
        {
          content: '{\n  "quietStartup": true\n}\n',
          path: "agent/settings.json",
        },
        ...(needsWrapper
          ? [
              {
                content: createPiWrapper(
                  this.#options.piCommand,
                  context.request.permissions,
                  usesMcp,
                  this.#options.mcpAdapterPath
                ),
                executable: true,
                path: "pi-for-aml",
              },
            ]
          : []),
        ...(usesMcp
          ? [
              {
                content: createPiMcpConfiguration(context.mcpServers),
                path: "agent/mcp.json",
              },
              {
                // An existing empty cache keeps lazy servers lazy on the first
                // invocation instead of emitting connection UI before a turn.
                content: '{\n  "version": 1,\n  "servers": {}\n}\n',
                path: "agent/mcp-cache.json",
              },
            ]
          : []),
      ],
      ...(usesMcp
        ? {
            // pi-acp currently stores ACP MCP descriptors but does not connect
            // them. The maintained Pi extension above owns those connections.
            sessionMcpServers: [],
          }
        : {}),
      ...(context.request.system.length === 0 && !usesMcp
        ? {}
        : {
            // ACP has no system-instruction field and pi-acp does not expose
            // Pi's CLI flag, so retain the authored priority as first-turn text.
            initialPromptPrefix: [
              ...(context.request.system.length === 0 ? [] : [`<SYSTEM>\n${context.request.system}\n</SYSTEM>`]),
              ...(usesMcp
                ? [
                    "AML JavaScript Tools and MCP capabilities use Pi's mcp proxy. Call mcp with the exact tool name and an args object.",
                  ]
                : []),
            ].join("\n\n"),
          }),
      permissionPolicy: "allow_always",
      structuredOutputInstruction:
        'Call the mcp tool exactly once with tool "aml_submit_result". ' +
        'Pass the final value as args.result, for example {"tool":"aml_submit_result","args":{"result":...}}. ' +
        "Do not return substitute JSON only as message text.",
      transformText: stripPiAcpStartupInfo,
    })
  }
}

/**
 * Creates a Pi coding Agent through the maintained pi-acp adapter.
 */
export function piAgent(options: PiAgentOptions = {}): Readonly<PiAgentProvider> {
  const profile = new PiAcpProfile(captureOptions(options))
  return defineAcpAgentProvider(profile)
}

function captureOptions(options: PiAgentOptions): Readonly<CapturedPiAgentOptions> {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Pi Agent options must be an object")
  }

  const args = options.args ?? []
  const command = normalizedString(options.command ?? "pi-acp", "Pi ACP command")
  const env = options.env ?? {}
  const mcpAdapterPath = optionalNormalizedString(options.mcpAdapterPath, "Pi MCP adapter path")
  const model = optionalNormalizedString(options.model, "Pi model")
  const piCommand = normalizedString(options.piCommand ?? "pi", "Pi command")
  const thinkingLevel = optionalNormalizedString(options.thinkingLevel, "Pi thinkingLevel")
  const workingDirectory = optionalNormalizedString(options.workingDirectory, "Pi workingDirectory")

  if (!Array.isArray(args) || args.some(argument => typeof argument !== "string" || argument.includes("\0"))) {
    throw new TypeError("Pi ACP args must be strings without null bytes")
  }

  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new TypeError("Pi env must be an object")
  }

  return Object.freeze({
    args: Object.freeze([...args]),
    command,
    env: Object.freeze({ ...env }),
    ...(mcpAdapterPath === undefined ? {} : { mcpAdapterPath }),
    ...(model === undefined ? {} : { model }),
    piCommand,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  })
}

function stripPiAcpStartupInfo(
  text: string,
  session: Parameters<NonNullable<AcpAgentLaunch["transformText"]>>[1]
): string {
  const metadata = session.meta
  if (typeof metadata !== "object" || metadata === null) return text
  const piAcp = Reflect.get(metadata, "piAcp")
  if (typeof piAcp !== "object" || piAcp === null) return text
  const startupInfo = Reflect.get(piAcp, "startupInfo")
  return typeof startupInfo === "string" && text.startsWith(startupInfo) ? text.slice(startupInfo.length) : text
}

function hasDefaultPiPermissions(permissions: AcpAgentLaunchContext["request"]["permissions"]): boolean {
  return permissions.filesystem === "read-write" && permissions.network && permissions.shell
}

function createPiWrapper(
  piCommand: string,
  permissions: AcpAgentLaunchContext["request"]["permissions"],
  usesMcp: boolean,
  adapterPath: string | undefined
): string {
  const tools = ["read", "grep", "find", "ls"]
  if (permissions.filesystem === "read-write") tools.push("edit", "write")
  if (permissions.shell) tools.push("bash")
  if (usesMcp) tools.push("mcp")

  const adapter = !usesMcp
    ? ""
    : adapterPath === undefined
      ? '\nadapter_path="$(dirname "$(readlink -f "$(command -v pi-mcp-adapter)")")/index.ts"'
      : `\nadapter_path=${shellArgument(adapterPath)}`
  const command = `exec ${shellArgument(piCommand)} --tools ${shellArgument(tools.join(","))}`

  return `#!/bin/sh${adapter}\n${command}${usesMcp ? ' -e "$adapter_path"' : ""} "$@"\n`
}

function createPiMcpConfiguration(servers: AcpAgentLaunchContext["mcpServers"]): string {
  return `${JSON.stringify(
    {
      mcpServers: Object.fromEntries(servers.map(server => [server.name, createPiMcpServerConfiguration(server)])),
    },
    null,
    2
  )}\n`
}

function createPiMcpServerConfiguration(
  server: AcpAgentLaunchContext["mcpServers"][number]
): Readonly<Record<string, unknown>> {
  if ("url" in server) {
    return {
      directTools: false,
      headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])),
      lifecycle: "lazy",
      toolPrefix: "none",
      url: server.url,
    }
  }

  if ("command" in server) {
    return {
      args: [...server.args],
      command: server.command,
      directTools: false,
      env: Object.fromEntries(server.env.map(variable => [variable.name, variable.value])),
      lifecycle: "lazy",
      toolPrefix: "none",
    }
  }

  throw new TypeError(`Pi MCP adapter cannot represent ACP-native server "${server.name}"`)
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function optionalNormalizedString(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : normalizedString(value, label)
}

function normalizedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty normalized string`)
  }

  return value
}
