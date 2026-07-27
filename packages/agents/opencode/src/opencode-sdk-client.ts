import type { OpencodeClient } from "@opencode-ai/sdk/v2"

import type {
  OpenCodeSessionClient,
  OpenCodeCapabilityAttachmentInput,
  OpenCodeSessionCreateInput,
  OpenCodeSessionLocation,
  OpenCodeSessionPromptInput,
  OpenCodeSessionPromptResult,
} from "./opencode-session-client.js"
import { OpenCodeCapabilityAttachment } from "./opencode-capability-attachment.js"
import { OpenCodeToolBridge } from "./opencode-tool-bridge.js"

const SUPPORTED_CAPABILITY_SERVER_VERSIONS = new Set([
  "1.18.4",
  "1.18.5",
])

/**
 * Maps the generated OpenCode v2 client into AML's small session port.
 */
export class OpenCodeSdkClient implements OpenCodeSessionClient {
  readonly #client: OpencodeClient

  /**
   * Wraps one generated SDK client behind AML's narrow provider port.
   */
  constructor(client: OpencodeClient) {
    this.#client = client
  }

  /**
   * Preflights and attaches the complete Agent capability set.
   */
  async attachCapabilities(
    input: OpenCodeCapabilityAttachmentInput,
    signal: AbortSignal,
  ): Promise<OpenCodeCapabilityAttachment> {
    // Fail closed: OpenCode's wildcard must be disabled before selectively
    // enabling only capabilities declared by the nearest AML Agent.
    const enabled: Record<string, boolean> = { "*": false }

    if (
      input.tools.length === 0 &&
      input.mcpServers.length === 0 &&
      !input.structuredOutput
    ) {
      return new OpenCodeCapabilityAttachment(
        enabled,
        async () => undefined,
      )
    }

    // Capability scoping mirrors OpenCode server internals that are not part of
    // the generated client contract. Reject an unreviewed server before setup.
    await this.#assertCapabilityServerVersion(signal)

    // Provider-native Tools and AML JavaScript Tools have independent discovery
    // and attachment mechanisms even though they share one final tools map.
    const hostTools = input.tools.filter(
      (tool) => tool.kind === "host",
    )
    const javaScriptTools = input.tools.filter(
      (tool) => tool.kind === "javascript",
    )
    let bridge: OpenCodeToolBridge | undefined
    let bridgeName: string | undefined
    const connectedNames: string[] = []
    const cleanup = async () => {
      // Disconnect provider clients before closing the local Tool bridge.
      // Preserve every cleanup failure in reverse acquisition order.
      const errors: unknown[] = []

      for (const name of [...connectedNames].reverse()) {
        try {
          await this.#disconnectMcp(name, input.directory)
        } catch (error) {
          errors.push(error)
        }
      }

      if (bridge) {
        try {
          await bridge.close()
        } catch (error) {
          errors.push(error)
        }
      }

      if (errors.length === 1) {
        throw errors[0]
      }

      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "OpenCode capability cleanup failed",
        )
      }
    }

    try {
      const normalizedServerNames = new Map<string, string>()

      // OpenCode prefixes MCP Tools with its normalized server name. Reject
      // aliases that would collapse or nest one capability namespace.
      for (const server of input.mcpServers) {
        const name =
          server.kind === "named" ? server.name : server.definition.name
        const normalized = OpenCodeSdkClient.#permissionCanonical(
          OpenCodeSdkClient.#sanitizeToolName(name),
        )

        if (normalizedServerNames.has(normalized)) {
          throw new TypeError(
            "OpenCode MCP server names collide after provider normalization",
          )
        }

        for (const existing of normalizedServerNames.keys()) {
          if (
            normalized.startsWith(`${existing}_`) ||
            existing.startsWith(`${normalized}_`)
          ) {
            throw new TypeError(
              "OpenCode MCP server names overlap after provider normalization",
            )
          }
        }

        normalizedServerNames.set(normalized, name)
      }

      if (javaScriptTools.length > 0) {
        const sanitizedNames = new Set<string>()

        // OpenCode/MCP only supports object-root tool arguments and normalizes
        // names before registration. Reject both incompatibilities up front.
        for (const tool of javaScriptTools) {
          if (tool.inputSchema.type !== "object") {
            throw new TypeError(
              `OpenCode Tool "${tool.name}" requires an object input schema`,
            )
          }

          const sanitized = OpenCodeSdkClient.#sanitizeToolName(tool.name)

          if (sanitizedNames.has(sanitized)) {
            throw new TypeError(
              "OpenCode JavaScript Tool names collide after provider normalization",
            )
          }

          sanitizedNames.add(sanitized)
        }

        // The bridge carries application closures, so it binds to loopback with
        // per-invocation authorization and exists only for this attachment.
        bridge = new OpenCodeToolBridge(
          javaScriptTools,
          input.context,
        )
        const connection = await bridge.start(signal)
        bridgeName = connection.name
        connectedNames.push(connection.name)
        const { data } = await this.#client.mcp.add(
          {
            ...(input.directory === undefined
              ? {}
              : { directory: input.directory }),
            config: {
              enabled: true,
              headers: { ...connection.headers },
              type: "remote",
              url: connection.url,
            },
            name: connection.name,
          },
          { signal, throwOnError: true },
        )
        // mcp.add can return without a usable connection; require the exact
        // connected status before opening the Agent session.
        const status =
          typeof data === "object" && data !== null
            ? Reflect.get(data, connection.name)
            : undefined

        if (
          typeof status !== "object" ||
          status === null ||
          Reflect.get(status, "status") !== "connected"
        ) {
          throw new Error(
            `OpenCode did not connect AML Tool bridge ${connection.name}`,
          )
        }
      }

      for (const server of input.mcpServers) {
        await this.#attachMcp(
          server,
          input.directory,
          signal,
          (attemptedName) => {
            // Once OpenCode receives connect/add, the registration may have
            // committed even if its response fails. Cleanup must reconcile it.
            connectedNames.push(attemptedName)
          },
        )
      }

      const availableHostTools =
        input.mcpServers.length > 0 ||
        hostTools.length > 0 ||
        input.structuredOutput
          ? await this.#toolIds(input.directory, signal)
          : new Set<string>()

      if (input.structuredOutput) {
        const reservedName = OpenCodeSdkClient.#permissionCanonical(
          "StructuredOutput",
        )
        const declaredCollision = hostTools.find(
          (tool) =>
            OpenCodeSdkClient.#permissionCanonical(tool.name) ===
            reservedName,
        )
        const ambientCollision = [...availableHostTools].find(
          (toolId) =>
            OpenCodeSdkClient.#permissionCanonical(toolId) ===
            reservedName,
        )

        // Structured output is implemented by a provider-injected Tool. A host
        // Tool with the same platform-equivalent ID would make the exact grant
        // ambiguous, so reject before creating any OpenCode session.
        if (declaredCollision || ambientCollision) {
          throw new TypeError(
            'OpenCode host Tool "StructuredOutput" is reserved by structured requests',
          )
        }

        enabled.StructuredOutput = true
      }

      if (input.mcpServers.length > 0 || hostTools.length > 0) {
        await this.#assertCapabilityNamespaceIsolation(
          input.mcpServers,
          availableHostTools,
          new Set(hostTools.map((tool) => tool.name)),
          input.directory,
          signal,
        )

        for (const server of input.mcpServers) {
          const name =
            server.kind === "named"
              ? server.name
              : server.definition.name

          enabled[
            `${OpenCodeSdkClient.#sanitizeToolName(name)}_*`
          ] = true
        }
      }

      if (hostTools.length > 0) {
        for (const tool of hostTools) {
          if (!availableHostTools.has(tool.name)) {
            throw new Error(
              `OpenCode host Tool "${tool.name}" is unavailable`,
            )
          }

          // OpenCode treats Tool-map keys as wildcard patterns. Exact AML
          // grants must never be able to replace or broaden the deny-all rule.
          if (/[*?]/u.test(tool.name)) {
            throw new Error(
              `OpenCode host Tool "${tool.name}" contains wildcard syntax`,
            )
          }

          enabled[tool.name] = true
        }
      }

      if (bridgeName) {
        for (const tool of javaScriptTools) {
          const id = `${bridgeName}_${OpenCodeSdkClient.#sanitizeToolName(tool.name)}`
          // OpenCode's Tool IDs endpoint contains registry Tools only. MCP
          // Tools are added during session resolution using this namespacing.
          enabled[id] = true
        }
      }

      return new OpenCodeCapabilityAttachment(enabled, cleanup)
    } catch (error) {
      // Partial setup can leave provider clients and a listening bridge.
      // Cleanup failures remain visible beside the setup failure.
      const errors: unknown[] = [error]

      try {
        await cleanup()
      } catch (cleanupError) {
        errors.push(cleanupError)
      }

      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "OpenCode capability setup and cleanup failed",
        )
      }

      throw error
    }
  }

  /**
   * Rejects cross-source names that OpenCode's shared Tool map cannot isolate.
   */
  async #assertCapabilityNamespaceIsolation(
    servers: OpenCodeCapabilityAttachmentInput["mcpServers"],
    hostToolIds: ReadonlySet<string>,
    declaredHostToolIds: ReadonlySet<string>,
    directory: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const statuses = await this.#mcpStatus(directory, signal)
    const declaredNames = new Set(
      servers.map((server) =>
        server.kind === "named"
          ? server.name
          : server.definition.name,
      ),
    )
    const declaredNamespaces = new Map(
      [...declaredNames].map((name) => [
        name,
        OpenCodeSdkClient.#permissionCanonical(
          OpenCodeSdkClient.#sanitizeToolName(name),
        ),
      ]),
    )

    for (const configuredName of Object.keys(statuses)) {
      if (declaredNames.has(configuredName)) {
        continue
      }

      const configuredNamespace =
        OpenCodeSdkClient.#permissionCanonical(
          OpenCodeSdkClient.#sanitizeToolName(configuredName),
        )

      for (const [declaredName, declaredNamespace] of declaredNamespaces) {
        if (
          configuredNamespace === declaredNamespace ||
          configuredNamespace.startsWith(`${declaredNamespace}_`) ||
          declaredNamespace.startsWith(`${configuredNamespace}_`)
        ) {
          throw new Error(
            `OpenCode MCP server "${declaredName}" overlaps undeclared server "${configuredName}"`,
          )
        }
      }
    }

    // An exact host Tool can still collide with a generated MCP Tool ID. Since
    // OpenCode does not expose MCP Tool IDs before prompt resolution, reject
    // every host grant that could fall inside any configured server namespace.
    for (const toolId of declaredHostToolIds) {
      for (const configuredName of Object.keys(statuses)) {
        const configuredNamespace =
          OpenCodeSdkClient.#permissionCanonical(
            OpenCodeSdkClient.#sanitizeToolName(configuredName),
          )
        const canonicalToolId =
          OpenCodeSdkClient.#permissionCanonical(toolId)

        if (canonicalToolId.startsWith(`${configuredNamespace}_`)) {
          throw new Error(
            `OpenCode host Tool "${toolId}" overlaps MCP server "${configuredName}"`,
          )
        }
      }
    }

    // OpenCode applies the same wildcard map to built-in/plugin and MCP Tools.
    // A server namespace must not silently authorize an ambient host Tool.
    for (const toolId of hostToolIds) {
      if (declaredHostToolIds.has(toolId)) {
        continue
      }

      const canonicalToolId =
        OpenCodeSdkClient.#permissionCanonical(toolId)

      for (const [declaredName, declaredNamespace] of declaredNamespaces) {
        if (canonicalToolId.startsWith(`${declaredNamespace}_`)) {
          throw new Error(
            `OpenCode MCP server "${declaredName}" overlaps undeclared host Tool "${toolId}"`,
          )
        }
      }
    }

    // Exact grants are still wildcard patterns inside OpenCode. Reject two
    // provider IDs that its platform matcher would treat as the same literal.
    for (const declaredToolId of declaredHostToolIds) {
      const canonicalDeclared =
        OpenCodeSdkClient.#permissionCanonical(declaredToolId)
      const equivalents = [...hostToolIds].filter(
        (toolId) =>
          OpenCodeSdkClient.#permissionCanonical(toolId) ===
          canonicalDeclared,
      )

      if (
        equivalents.length > 1 ||
        (equivalents.length === 1 &&
          equivalents[0] !== declaredToolId)
      ) {
        throw new Error(
          `OpenCode host Tool "${declaredToolId}" has permission-equivalent provider Tool IDs`,
        )
      }
    }
  }

  /**
   * Connects one named or explicitly configured MCP server.
   */
  async #attachMcp(
    server: OpenCodeCapabilityAttachmentInput["mcpServers"][number],
    directory: string | undefined,
    signal: AbortSignal,
    onConnectionAttempt: (name: string) => void,
  ): Promise<string> {
    const name =
      server.kind === "named" ? server.name : server.definition.name
    const existing = await this.#mcpStatus(directory, signal)

    if (server.kind === "named") {
      if (!Object.hasOwn(existing, name)) {
        throw new Error(
          `OpenCode named MCP server "${name}" is unavailable`,
        )
      }

      onConnectionAttempt(name)
      const { data } = await this.#client.mcp.connect(
        {
          ...(directory === undefined ? {} : { directory }),
          name,
        },
        { signal, throwOnError: true },
      )

      if (data !== true) {
        throw new Error(
          `OpenCode did not connect named MCP server "${name}"`,
        )
      }
    } else {
      if (Object.hasOwn(existing, name)) {
        throw new Error(
          `OpenCode configured MCP server "${name}" conflicts with provider configuration`,
        )
      }

      const transport = server.definition.transport

      // OpenCode 1.18 has no per-server cwd field. Query directory selects
      // project configuration, not the child process working directory.
      if (transport.type === "stdio" && transport.cwd !== undefined) {
        throw new Error(
          `OpenCode does not support cwd for MCP server "${name}"`,
        )
      }

      const config =
        transport.type === "stdio"
          ? {
              command: [transport.command, ...(transport.args ?? [])],
              enabled: true,
              ...(transport.env === undefined
                ? {}
                : { environment: { ...transport.env } }),
              type: "local" as const,
            }
          : {
              enabled: true,
              ...(transport.headers === undefined
                ? {}
                : { headers: { ...transport.headers } }),
              type: "remote" as const,
              url: transport.url,
            }
      onConnectionAttempt(name)
      const { data } = await this.#client.mcp.add(
        {
          ...(directory === undefined ? {} : { directory }),
          config,
          name,
        },
        { signal, throwOnError: true },
      )
      const status =
        typeof data === "object" && data !== null
          ? Reflect.get(data, name)
          : undefined

      if (
        typeof status !== "object" ||
        status === null ||
        Reflect.get(status, "status") !== "connected"
      ) {
        throw new Error(
          `OpenCode did not connect configured MCP server "${name}"`,
        )
      }
    }

    const connected = await this.#mcpStatus(directory, signal)
    const status = Reflect.get(connected, name)

    if (
      typeof status !== "object" ||
      status === null ||
      Reflect.get(status, "status") !== "connected"
    ) {
      throw new Error(
        `OpenCode MCP server "${name}" is not connected`,
      )
    }

    return name
  }

  /**
   * Reads one validated MCP status map from the provider boundary.
   */
  async #mcpStatus(
    directory: string | undefined,
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> {
    const { data } = await this.#client.mcp.status(
      directory === undefined ? {} : { directory },
      { signal, throwOnError: true },
    )

    if (
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data)
    ) {
      throw new TypeError("OpenCode returned invalid MCP status")
    }

    return data
  }

  /**
   * Disconnects one attached server and requires exact acknowledgement.
   */
  async #disconnectMcp(
    name: string,
    directory: string | undefined,
  ): Promise<void> {
    const { data } = await this.#client.mcp.disconnect(
      {
        ...(directory === undefined ? {} : { directory }),
        name,
      },
      { throwOnError: true },
    )

    if (data !== true) {
      throw new Error(
        `OpenCode did not disconnect MCP server "${name}"`,
      )
    }
  }

  /**
   * Creates one fresh OpenCode session and validates its acknowledged ID.
   */
  async create(
    input: OpenCodeSessionCreateInput,
    signal: AbortSignal,
  ): Promise<string> {
    const { data } = await this.#client.session.create(
      {
        ...(input.directory === undefined
          ? {}
          : { directory: input.directory }),
        ...(input.model === undefined
          ? {}
          : {
              model: {
                id: input.model.modelId,
                providerID: input.model.providerId,
              },
            }),
        title: input.title,
      },
      { signal, throwOnError: true },
    )

    const rawData: unknown = data

    if (typeof rawData !== "object" || rawData === null) {
      throw new TypeError("OpenCode returned invalid session data")
    }

    const id = (rawData as { readonly id?: unknown }).id

    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("OpenCode returned an invalid session ID")
    }

    return id
  }

  /**
   * Sends one Agent turn through the generated SDK.
   */
  async prompt(
    input: OpenCodeSessionPromptInput,
    signal: AbortSignal,
  ): Promise<OpenCodeSessionPromptResult> {
    const { data } = await this.#client.session.prompt(
      {
        ...(input.directory === undefined
          ? {}
          : { directory: input.directory }),
        ...(input.model === undefined
          ? {}
          : {
              model: {
                modelID: input.model.modelId,
                providerID: input.model.providerId,
              },
            }),
        ...(input.output === undefined
          ? {}
          : {
              format: {
                schema: { ...input.output.jsonSchema },
                type: "json_schema" as const,
              },
            }),
        parts: [{ text: input.prompt, type: "text" }],
        sessionID: input.sessionId,
        system: input.system,
        tools: { ...input.tools },
      },
      { signal, throwOnError: true },
    )

    // The generated client types describe success, but the network boundary can
    // still return malformed data. Validate before orchestration consumes it.
    const rawData: unknown = data

    if (typeof rawData !== "object" || rawData === null) {
      throw new TypeError("OpenCode returned invalid prompt data")
    }

    const info = (rawData as { readonly info?: unknown }).info

    if (typeof info !== "object" || info === null) {
      throw new TypeError("OpenCode returned invalid assistant metadata")
    }

    const error = (info as { readonly error?: unknown }).error
    const parts = (rawData as { readonly parts?: unknown }).parts
    const hasStructured = Reflect.has(info, "structured")
    const structured = hasStructured
      ? Reflect.get(info, "structured")
      : undefined

    if (!Array.isArray(parts)) {
      throw new TypeError("OpenCode returned invalid prompt parts")
    }

    return Object.freeze({
      ...(error === undefined ? {} : { error }),
      parts: Object.freeze([...parts]),
      ...(hasStructured ? { structured } : {}),
    })
  }

  /**
   * Requests cancellation and requires OpenCode's exact acknowledgement.
   */
  async abort(input: OpenCodeSessionLocation): Promise<void> {
    const { data } = await this.#client.session.abort(
      {
        ...(input.directory === undefined
          ? {}
          : { directory: input.directory }),
        sessionID: input.sessionId,
      },
      { throwOnError: true },
    )

    if (data !== true) {
      throw new Error(`OpenCode did not abort session ${input.sessionId}`)
    }
  }

  /**
   * Deletes an acknowledged session and requires exact provider confirmation.
   */
  async delete(input: OpenCodeSessionLocation): Promise<void> {
    const { data } = await this.#client.session.delete(
      {
        ...(input.directory === undefined
          ? {}
          : { directory: input.directory }),
        sessionID: input.sessionId,
      },
      { throwOnError: true },
    )

    if (data !== true) {
      throw new Error(`OpenCode did not delete session ${input.sessionId}`)
    }
  }

  /**
   * Verifies the running server implements the reviewed permission semantics.
   */
  async #assertCapabilityServerVersion(signal: AbortSignal): Promise<void> {
    const { data } = await this.#client.global.health({
      signal,
      throwOnError: true,
    })
    const health: unknown = data

    if (typeof health !== "object" || health === null) {
      throw new TypeError("OpenCode returned invalid health data")
    }

    let healthy: unknown
    let version: unknown

    try {
      // Capture each provider value once so validation and compatibility use
      // the same health response even when a hostile accessor is returned.
      healthy = Reflect.get(health, "healthy")
      version = Reflect.get(health, "version")
    } catch (cause) {
      throw new TypeError("OpenCode returned invalid health data", {
        cause,
      })
    }

    if (healthy !== true || typeof version !== "string") {
      throw new TypeError("OpenCode returned invalid health data")
    }

    if (!SUPPORTED_CAPABILITY_SERVER_VERSIONS.has(version)) {
      throw new Error(
        `OpenCode server ${version} is unsupported for capability isolation`,
      )
    }
  }

  /**
   * Reads and validates the provider-native Tool registry for one directory.
   */
  async #toolIds(
    directory: string | undefined,
    signal: AbortSignal,
  ): Promise<ReadonlySet<string>> {
    // Capture the registry response as unknown because provider/plugin output
    // can violate generated SDK types at runtime.
    const { data } = await this.#client.tool.ids(
      directory === undefined ? {} : { directory },
      { signal, throwOnError: true },
    )

    if (!Array.isArray(data)) {
      throw new TypeError("OpenCode returned invalid Tool IDs")
    }

    // Snapshot before validation so a stateful array getter cannot report one
    // capability during validation and authorize another during Set creation.
    const ids = [...data] as unknown[]

    if (ids.some((value) => typeof value !== "string")) {
      throw new TypeError("OpenCode returned invalid Tool IDs")
    }

    return new Set(ids as string[])
  }

  /**
   * Mirrors the reviewed OpenCode 1.18.4/1.18.5 MCP Tool-ID normalization.
   *
   * The normalized value is part of the authorization boundary: it drives
   * collision checks, namespace isolation, and the emitted grant pattern.
   */
  static #sanitizeToolName(value: string): string {
    // Reject collisions before registration rather than allowing one server
    // namespace to shadow or authorize another server's Tool.
    return value.replace(/[^a-zA-Z0-9_-]/g, "_")
  }

  /**
   * Mirrors OpenCode's platform-sensitive wildcard literal equivalence.
   */
  static #permissionCanonical(value: string): string {
    const slashed = value.replaceAll("\\", "/")
    return process.platform === "win32"
      ? slashed.toLowerCase()
      : slashed
  }
}
