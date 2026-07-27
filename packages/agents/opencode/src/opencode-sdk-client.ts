import type { OpencodeClient } from "@opencode-ai/sdk/v2"

import type {
  OpenCodeSessionClient,
  OpenCodeSessionCreateInput,
  OpenCodeSessionLocation,
  OpenCodeSessionPromptInput,
  OpenCodeSessionPromptResult,
  OpenCodeToolAttachmentInput,
} from "./opencode-session-client.js"
import { OpenCodeToolAttachment } from "./opencode-tool-attachment.js"
import { OpenCodeToolBridge } from "./opencode-tool-bridge.js"

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
   * Preflights host Tools and exposes JavaScript Tools through localhost MCP.
   */
  async attachTools(
    input: OpenCodeToolAttachmentInput,
    signal: AbortSignal,
  ): Promise<OpenCodeToolAttachment> {
    // Fail closed: OpenCode's wildcard must be disabled before selectively
    // enabling only capabilities declared by the nearest AML Agent.
    const enabled: Record<string, boolean> = { "*": false }

    if (input.tools.length === 0) {
      return new OpenCodeToolAttachment(enabled, async () => undefined)
    }

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

    try {
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

      // Host Tool names come from the provider registry, not from MCP state.
      const available = await this.#toolIds(input.directory, signal)

      for (const tool of hostTools) {
        if (!available.has(tool.name)) {
          throw new Error(
            `OpenCode host Tool "${tool.name}" is unavailable`,
          )
        }

        enabled[tool.name] = true
      }

      if (bridgeName) {
        for (const tool of javaScriptTools) {
          const id = `${bridgeName}_${OpenCodeSdkClient.#sanitizeToolName(tool.name)}`
          // OpenCode's Tool IDs endpoint contains registry Tools only. MCP
          // Tools are added during session resolution using this namespacing.
          enabled[id] = true
        }
      }

      return new OpenCodeToolAttachment(enabled, async () => {
        // Disconnect OpenCode before closing localhost so its MCP client sees an
        // orderly shutdown. Preserve both failures if either boundary breaks.
        const errors: unknown[] = []

        if (bridgeName) {
          try {
            const { data } = await this.#client.mcp.disconnect(
              {
                ...(input.directory === undefined
                  ? {}
                  : { directory: input.directory }),
                name: bridgeName,
              },
              { throwOnError: true },
            )

            if (data !== true) {
              throw new Error(
                `OpenCode did not disconnect AML Tool bridge ${bridgeName}`,
              )
            }
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
            "OpenCode Tool attachment cleanup failed",
          )
        }
      })
    } catch (error) {
      // Partial setup can leave both an OpenCode registration and a listening
      // bridge. Cleanup failures must remain visible beside the setup failure.
      const errors: unknown[] = [error]

      if (bridgeName) {
        try {
          const { data } = await this.#client.mcp.disconnect(
            {
              ...(input.directory === undefined
                ? {}
                : { directory: input.directory }),
              name: bridgeName,
            },
            { throwOnError: true },
          )

          if (data !== true) {
            throw new Error(
              `OpenCode did not disconnect AML Tool bridge ${bridgeName}`,
            )
          }
        } catch (cleanupError) {
          errors.push(cleanupError)
        }
      }

      if (bridge) {
        try {
          await bridge.close()
        } catch (cleanupError) {
          errors.push(cleanupError)
        }
      }

      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "OpenCode Tool attachment setup and cleanup failed",
        )
      }

      throw error
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
   * Sends the initial Agent request through the generated SDK.
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

    if (!Array.isArray(parts)) {
      throw new TypeError("OpenCode returned invalid prompt parts")
    }

    return Object.freeze({
      ...(error === undefined ? {} : { error }),
      parts: Object.freeze([...parts]),
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

    if (
      !Array.isArray(data) ||
      data.some((value) => typeof value !== "string")
    ) {
      throw new TypeError("OpenCode returned invalid Tool IDs")
    }

    return new Set(data)
  }

  /**
   * Mirrors OpenCode's MCP identifier normalization for collision detection.
   */
  static #sanitizeToolName(value: string): string {
    // This mirrors OpenCode v1.18.4's MCP Tool ID normalization. Collisions are
    // rejected before registration rather than silently shadowing a Tool.
    return value.replace(/[^a-zA-Z0-9_-]/g, "_")
  }
}
