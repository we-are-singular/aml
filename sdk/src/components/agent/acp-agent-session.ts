import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type ActiveSession,
  type ClientConnection,
  type McpServer,
  type PermissionOptionKind,
  type RequestPermissionResponse,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk"

import type { AgentExecutionContext } from "./agent-execution-context.js"
import type { AgentProviderSession, AgentProviderTurn } from "./agent-provider-session.js"
import type { AgentResponse } from "./agent-response.js"
import type { SandboxProcess } from "../sandbox/sandbox-runtime.js"

export interface AcpSessionOpenInput {
  readonly authenticationMethodId?: string
  readonly configuration?: readonly AcpSessionConfiguration[]
  readonly cwd: string
  readonly initialPromptPrefix?: string
  readonly mcpServers?: readonly McpServer[]
  readonly permissionPolicy?: AcpPermissionPolicy
  readonly process: Readonly<SandboxProcess>
  readonly signal: AbortSignal
  readonly structuredOutput?: AcpStructuredOutputController
  readonly structuredOutputInstruction?: string
  readonly transformText?: AcpSessionTextTransform
}

/**
 * Non-interactive response AML selects for ACP permission requests.
 *
 * Agent profiles choose this workflow policy. Sandbox access and isolation
 * remain the security boundary for native Agent operations.
 */
export type AcpPermissionPolicy = PermissionOptionKind

/**
 * One requested ACP session option matched by stable id or semantic category.
 */
export type AcpSessionConfiguration =
  | {
      readonly category: string
      readonly id?: never
      readonly value: boolean | string
    }
  | {
      readonly category?: never
      readonly id: string
      readonly value: boolean | string
    }

/**
 * Invocation bridge used only on the authored structured-output turn.
 */
export interface AcpStructuredOutputController {
  readonly instruction: string
  beginStructuredTurn(): void
  structuredResult(): unknown
}

/**
 * Agent-profile hook for removing protocol-visible adapter prelude text.
 */
export type AcpSessionTextTransform = (text: string, session: ActiveSession) => string

/**
 * Opens and drives one ACP session over a provider-neutral process handle.
 *
 * Agent profiles configure and launch the process. This function owns only the
 * shared ACP initialization, prompting, cancellation, streaming, and cleanup.
 */
export async function openAcpSession(input: Readonly<AcpSessionOpenInput>): Promise<AgentProviderSession> {
  input.signal.throwIfAborted()
  const stderr = drainStderr(input.process.stderr)
  const app = client({ name: "aml" }).onRequest(
    methods.client.session.requestPermission,
    ({ params }): RequestPermissionResponse => {
      const policy = input.permissionPolicy ?? "reject_once"
      const selected =
        params.options.find(option => option.kind === policy) ??
        params.options.find(option => option.kind === permissionFallback(policy))

      return selected === undefined
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { optionId: selected.optionId, outcome: "selected" } }
    }
  )
  const connection = app.connect(ndJsonStream(input.process.stdin, input.process.stdout))

  try {
    const initialized = await connection.agent.request(
      methods.agent.initialize,
      {
        clientCapabilities: {},
        clientInfo: {
          name: "aml",
          title: "Agent Markup Language",
          version: "0.0.0",
        },
        protocolVersion: PROTOCOL_VERSION,
      },
      { cancellationSignal: input.signal }
    )
    validateMcpCapabilities(initialized.agentCapabilities?.mcpCapabilities, input.mcpServers ?? [])

    if (input.authenticationMethodId !== undefined) {
      await connection.agent.request(
        methods.agent.authenticate,
        { methodId: input.authenticationMethodId },
        { cancellationSignal: input.signal }
      )
    }

    const session = await connection.agent
      .buildSession({
        cwd: input.cwd,
        mcpServers: [...(input.mcpServers ?? [])],
      })
      .start({ cancellationSignal: input.signal })
    await configureSession(connection, session, input.configuration ?? [], input.signal)
    return new AcpProviderSession(
      connection,
      session,
      input.process,
      stderr,
      input.initialPromptPrefix,
      input.structuredOutput,
      input.structuredOutputInstruction,
      input.transformText
    )
  } catch (error) {
    connection.close(error)
    await input.process.kill().catch(() => undefined)
    await stderr.catch(() => undefined)
    throw error
  }
}

class AcpProviderSession implements AgentProviderSession {
  readonly #connection: ClientConnection
  readonly #process: Readonly<SandboxProcess>
  readonly #session: ActiveSession
  readonly #stderr: Promise<string>
  readonly #structuredOutput: AcpStructuredOutputController | undefined
  readonly #structuredOutputInstruction: string | undefined
  readonly #transformText: AcpSessionTextTransform | undefined
  #initialPromptPrefix: string | undefined
  #closePromise: Promise<void> | undefined

  constructor(
    connection: ClientConnection,
    session: ActiveSession,
    process: Readonly<SandboxProcess>,
    stderr: Promise<string>,
    initialPromptPrefix: string | undefined,
    structuredOutput: AcpStructuredOutputController | undefined,
    structuredOutputInstruction: string | undefined,
    transformText: AcpSessionTextTransform | undefined
  ) {
    this.#connection = connection
    this.#session = session
    this.#process = process
    this.#stderr = stderr
    this.#initialPromptPrefix = initialPromptPrefix
    this.#structuredOutput = structuredOutput
    this.#structuredOutputInstruction = structuredOutputInstruction
    this.#transformText = transformText
  }

  async runTurn(turn: Readonly<AgentProviderTurn>, context: AgentExecutionContext): Promise<AgentResponse> {
    const prefix = this.#initialPromptPrefix
    this.#initialPromptPrefix = undefined
    let prompt = prefix === undefined ? turn.prompt : `${prefix}\n\n${turn.prompt}`

    if (turn.output !== undefined) {
      if (this.#structuredOutput === undefined) {
        throw new Error("ACP structured turn has no AML submission bridge")
      }

      this.#structuredOutput.beginStructuredTurn()
      prompt = `${prompt}\n\n${this.#structuredOutputInstruction ?? this.#structuredOutput.instruction}`
    }

    const turnAttempt = (async () => {
      const completion = this.#session.prompt(prompt, {
        cancellationSignal: context.signal,
      })
      const receivedText = await this.#session.readText()
      await completion
      return receivedText
    })()
    const exited = this.#process.wait().then(async result => {
      const stderr = await this.#stderr.catch(() => "")
      const detail = stderr.trim().length === 0 ? "" : `: ${stderr.trim()}`
      throw new Error(`ACP Agent process exited with code ${result.exitCode} during a turn${detail}`)
    })
    const receivedText = await Promise.race([turnAttempt, exited])
    context.signal.throwIfAborted()
    const text = this.#transformText?.(receivedText, this.#session) ?? receivedText
    return Object.freeze({
      ...(turn.output === undefined ? {} : { structured: this.#structuredOutput?.structuredResult() }),
      text,
    })
  }

  async abort(): Promise<void> {
    await this.#connection.agent.notify(methods.agent.session.cancel, {
      sessionId: this.#session.sessionId,
    })
  }

  async close(): Promise<void> {
    this.#closePromise ??= this.#close()
    await this.#closePromise
  }

  async #close(): Promise<void> {
    this.#session.dispose()
    this.#connection.close()
    const errors: unknown[] = []

    try {
      await this.#process.kill()
    } catch (error) {
      errors.push(error)
    }

    await this.#stderr.catch(error => errors.push(error))

    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "ACP session cleanup failed")
  }
}

async function configureSession(
  connection: ClientConnection,
  session: ActiveSession,
  requested: readonly AcpSessionConfiguration[],
  signal: AbortSignal
): Promise<void> {
  let available = session.newSessionResponse.configOptions ?? []

  for (const configuration of requested) {
    const option = available.find(candidate =>
      configuration.id === undefined ? candidate.category === configuration.category : candidate.id === configuration.id
    )
    const label = configuration.id === undefined ? `category "${configuration.category}"` : `id "${configuration.id}"`

    if (option === undefined) {
      throw new Error(`ACP Agent does not advertise requested session configuration ${label}`)
    }

    validateSessionConfigurationValue(option, configuration.value)
    const response = await connection.agent.request(
      methods.agent.session.setConfigOption,
      {
        configId: option.id,
        sessionId: session.sessionId,
        ...(typeof configuration.value === "boolean"
          ? { type: "boolean", value: configuration.value }
          : { value: configuration.value }),
      },
      { cancellationSignal: signal }
    )
    available = response.configOptions
  }
}

function validateSessionConfigurationValue(option: SessionConfigOption, value: boolean | string): void {
  if (option.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new TypeError(`ACP session configuration "${option.id}" requires a boolean value`)
    }

    return
  }

  if (typeof value !== "string") {
    throw new TypeError(`ACP session configuration "${option.id}" requires a selected value id`)
  }

  const values = option.options.flatMap(candidate => ("options" in candidate ? candidate.options : [candidate]))
  if (!values.some(candidate => candidate.value === value)) {
    throw new Error(`ACP session configuration "${option.id}" does not advertise value "${value}"`)
  }
}

function permissionFallback(policy: AcpPermissionPolicy): AcpPermissionPolicy {
  switch (policy) {
    case "allow_always":
      return "allow_once"
    case "allow_once":
      return "allow_once"
    case "reject_always":
      return "reject_once"
    case "reject_once":
      return "reject_once"
  }
}

function validateMcpCapabilities(
  capabilities: Readonly<{ readonly http?: boolean; readonly sse?: boolean }> | undefined,
  servers: readonly McpServer[]
): void {
  for (const server of servers) {
    if ("type" in server && server.type === "http" && capabilities?.http !== true) {
      throw new Error(`ACP Agent does not advertise HTTP MCP support required by server "${server.name}"`)
    }

    if ("type" in server && server.type === "sse" && capabilities?.sse !== true) {
      throw new Error(`ACP Agent does not advertise SSE MCP support required by server "${server.name}"`)
    }
  }
}

async function drainStderr(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let tail = ""

  for await (const chunk of stream) {
    tail = `${tail}${decoder.decode(chunk, { stream: true })}`.slice(-16_384)
  }

  return `${tail}${decoder.decode()}`.slice(-16_384)
}
