import type {
  OpenCodeCapabilityAttachment,
  OpenCodeCapabilityAttachmentInput,
  OpenCodeSessionClient,
  OpenCodeSessionCreateInput,
  OpenCodeSessionLocation,
  OpenCodeSessionPromptInput,
  OpenCodeSessionPromptResult,
} from "./opencode-session-client.js"
import { OpenCodeSession } from "./opencode-session.js"

/**
 * Vendor-owned settings for a package-created local OpenCode server.
 */
export interface OpenCodeServerOptions {
  readonly hostname?: string

  /**
   * Fixed port for the reusable host; dynamic-capability hosts use port 0.
   */
  readonly port?: number
  readonly timeout?: number
}

/**
 * Configures the OpenCode adapter and its resource ownership.
 */
export interface OpenCodeAgentOptions {
  readonly directory?: string
  readonly model?: string
  readonly server?: OpenCodeServerOptions
  readonly sessionClient?: OpenCodeSessionClient
}

/**
 * Stable provider configuration after the external options boundary is read.
 */
export interface CapturedOpenCodeAgentOptions {
  readonly directory?: string
  readonly model?: string
  readonly server?: Readonly<OpenCodeServerOptions>
  readonly sessionClient?: OpenCodeSessionClient
}

/**
 * Validates and snapshots provider configuration at the factory boundary.
 */
export function captureOpenCodeAgentOptions(
  options: OpenCodeAgentOptions,
): Readonly<CapturedOpenCodeAgentOptions> {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("OpenCode Agent options must be an object")
  }

  // Capture every external property once. Accessor-backed configuration must
  // not validate one authority and substitute another when the Agent runs.
  const directory = options.directory
  const model = options.model
  const serverValue = options.server
  const sessionClientValue = options.sessionClient

  // Portable model parsing happens synchronously so invalid configured
  // identities never reach server or session creation.
  if (
    directory !== undefined &&
    (typeof directory !== "string" ||
      directory.length === 0)
  ) {
    throw new TypeError("OpenCode directory must be a non-empty string")
  }

  OpenCodeSession.parseModel(model)

  if (serverValue !== undefined && sessionClientValue !== undefined) {
    throw new TypeError(
      "OpenCode server and sessionClient options are mutually exclusive",
    )
  }

  const server =
    serverValue === undefined
      ? undefined
      : captureServerOptions(serverValue)
  const sessionClient =
    sessionClientValue === undefined
      ? undefined
      : captureSessionClient(sessionClientValue)

  return Object.freeze({
    ...(directory === undefined ? {} : { directory }),
    ...(model === undefined ? {} : { model }),
    ...(server === undefined ? {} : { server }),
    ...(sessionClient === undefined ? {} : { sessionClient }),
  })
}

/**
 * Snapshots child-host configuration without retaining external accessors.
 */
function captureServerOptions(
  value: OpenCodeServerOptions,
): Readonly<OpenCodeServerOptions> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("OpenCode server options must be an object")
  }

  const hostname = value.hostname
  const port = value.port
  const timeout = value.timeout

  if (
    hostname !== undefined &&
    (typeof hostname !== "string" || hostname.length === 0)
  ) {
    throw new TypeError(
      "OpenCode server hostname must be a non-empty string",
    )
  }

  if (
    port !== undefined &&
    (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
  ) {
    throw new TypeError(
      "OpenCode server port must be an integer between 0 and 65535",
    )
  }

  if (
    timeout !== undefined &&
    (!Number.isSafeInteger(timeout) || timeout < 0)
  ) {
    throw new TypeError(
      "OpenCode server timeout must be a non-negative safe integer",
    )
  }

  return Object.freeze({
    ...(hostname === undefined ? {} : { hostname }),
    ...(port === undefined ? {} : { port }),
    ...(timeout === undefined ? {} : { timeout }),
  })
}

/**
 * Captures an injected session port and binds each method to its original owner.
 */
function captureSessionClient(
  value: OpenCodeSessionClient,
): OpenCodeSessionClient {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("OpenCode sessionClient must be an object")
  }

  // Method getters are another authority boundary. Resolve each exactly once
  // before any remote session exists, then expose a stable AML-owned facade.
  const abort = captureSessionClientMethod(value, "abort")
  const attachCapabilities = captureSessionClientMethod(
    value,
    "attachCapabilities",
  )
  const create = captureSessionClientMethod(value, "create")
  const deleteSession = captureSessionClientMethod(value, "delete")
  const prompt = captureSessionClientMethod(value, "prompt")

  return Object.freeze({
    abort(input: OpenCodeSessionLocation): Promise<void> {
      return Reflect.apply(abort, value, [input])
    },
    attachCapabilities(
      input: OpenCodeCapabilityAttachmentInput,
      signal: AbortSignal,
    ): Promise<OpenCodeCapabilityAttachment> {
      return Reflect.apply(attachCapabilities, value, [input, signal])
    },
    create(
      input: OpenCodeSessionCreateInput,
      signal: AbortSignal,
    ): Promise<string> {
      return Reflect.apply(create, value, [input, signal])
    },
    delete(input: OpenCodeSessionLocation): Promise<void> {
      return Reflect.apply(deleteSession, value, [input])
    },
    prompt(
      input: OpenCodeSessionPromptInput,
      signal: AbortSignal,
    ): Promise<OpenCodeSessionPromptResult> {
      return Reflect.apply(prompt, value, [input, signal])
    },
  })
}

/**
 * Reads one injected port method without allowing validation/use substitution.
 */
function captureSessionClientMethod<
  Name extends keyof OpenCodeSessionClient,
>(
  client: OpenCodeSessionClient,
  name: Name,
): OpenCodeSessionClient[Name] {
  let method: unknown

  try {
    method = Reflect.get(client, name)
  } catch (cause) {
    throw new TypeError(
      `OpenCode sessionClient ${name} must be readable`,
      { cause },
    )
  }

  if (typeof method !== "function") {
    throw new TypeError(
      `OpenCode sessionClient ${name} must be a function`,
    )
  }

  return method as OpenCodeSessionClient[Name]
}
