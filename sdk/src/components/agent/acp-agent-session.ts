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
import { agentObservabilityServices, type AgentObservabilityServices } from "./agent-observability-services.js"
import type { AgentProviderSession, AgentProviderTurn } from "./agent-provider-session.js"
import type { AgentResponse } from "./agent-response.js"
import type { SandboxProcess } from "../sandbox/sandbox-runtime.js"

export interface AcpSessionOpenInput {
  readonly authenticationMethodId?: string
  readonly configuration?: readonly AcpSessionConfiguration[]
  readonly cwd: string
  readonly initialPromptPrefix?: string
  readonly mcpServers?: readonly McpServer[]
  readonly observability: AgentObservabilityServices
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
  hasStructuredResult(): boolean
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
  const observability = input.observability
  const sessionTrace = observability.currentTrace()
  let connection: ClientConnection | undefined
  let stderr: Promise<string> | undefined

  try {
    // From this point onward the ACP boundary owns the already-started process.
    // Even a pre-aborted signal must pass through the same termination path.
    input.signal.throwIfAborted()
    stderr = drainStderr(input.process.stderr)
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
    connection = app.connect(ndJsonStream(input.process.stdin, input.process.stdout))
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
    observability.event(sessionTrace, "acp.session.created", { sessionId: session.sessionId })
    await configureSession(connection, session, input.configuration ?? [], input.signal)
    return new AcpProviderSession({
      connection,
      initialPromptPrefix: input.initialPromptPrefix,
      observability,
      process: input.process,
      session,
      stderr,
      structuredOutput: input.structuredOutput,
      structuredOutputInstruction: input.structuredOutputInstruction,
      transformText: input.transformText,
    })
  } catch (error) {
    connection?.close(error)
    await Promise.allSettled([input.process.kill(), input.process.wait(), ...(stderr === undefined ? [] : [stderr])])
    throw error
  }
}

interface AcpProviderSessionOptions {
  readonly connection: ClientConnection
  readonly initialPromptPrefix: string | undefined
  readonly observability: AgentObservabilityServices
  readonly process: Readonly<SandboxProcess>
  readonly session: ActiveSession
  readonly stderr: Promise<string>
  readonly structuredOutput: AcpStructuredOutputController | undefined
  readonly structuredOutputInstruction: string | undefined
  readonly transformText: AcpSessionTextTransform | undefined
}

class AcpProviderSession implements AgentProviderSession {
  readonly #connection: ClientConnection
  readonly #observability: AgentObservabilityServices
  readonly #process: Readonly<SandboxProcess>
  readonly #session: ActiveSession
  readonly #stderr: Promise<string>
  readonly #structuredOutput: AcpStructuredOutputController | undefined
  readonly #structuredOutputInstruction: string | undefined
  readonly #transformText: AcpSessionTextTransform | undefined
  #initialPromptPrefix: string | undefined
  #closePromise: Promise<void> | undefined

  constructor(options: Readonly<AcpProviderSessionOptions>) {
    this.#connection = options.connection
    this.#session = options.session
    this.#process = options.process
    this.#stderr = options.stderr
    this.#observability = options.observability
    this.#initialPromptPrefix = options.initialPromptPrefix
    this.#structuredOutput = options.structuredOutput
    this.#structuredOutputInstruction = options.structuredOutputInstruction
    this.#transformText = options.transformText
  }

  async runTurn(turn: Readonly<AgentProviderTurn>, context: AgentExecutionContext): Promise<AgentResponse> {
    const prefix = this.#initialPromptPrefix
    this.#initialPromptPrefix = undefined
    let prompt = prefix === undefined ? turn.prompt : `${prefix}\n\n${turn.prompt}`
    let structuredOutput: AcpStructuredOutputController | undefined
    let structuredOutputInstruction: string | undefined

    if (turn.output !== undefined) {
      structuredOutput = this.#structuredOutput

      if (structuredOutput === undefined) {
        throw new Error("ACP structured turn has no AML submission bridge")
      }

      structuredOutputInstruction = this.#structuredOutputInstruction ?? structuredOutput.instruction
      structuredOutput.beginStructuredTurn()
      prompt = `${prompt}\n\n${structuredOutputInstruction}`
    }

    let receivedText = await this.#runPrompt(prompt, context)

    if (turn.output !== undefined && structuredOutput !== undefined && !structuredOutput.hasStructuredResult()) {
      // Some Agents finish their reasoning turn as text even though the result
      // Tool is available. Give the retained session one explicit repair turn
      // with both its provider-specific Tool identity and the output contract.
      receivedText = await this.#runPrompt(
        structuredOutputReminder(structuredOutputInstruction ?? structuredOutput.instruction, turn.output.jsonSchema),
        context
      )
    }

    context.signal.throwIfAborted()
    const text = this.#transformText?.(receivedText, this.#session) ?? receivedText
    return Object.freeze({
      ...(structuredOutput === undefined ? {} : { structured: structuredOutput.structuredResult() }),
      text,
    })
  }

  async #runPrompt(prompt: string, context: AgentExecutionContext): Promise<string> {
    const turnAttempt = runAcpPrompt(this.#session, prompt, context)

    // A silent Agent process exit would otherwise leave nextUpdate() waiting
    // forever. Preserve stderr only for the failure surfaced to the caller.
    const exited = this.#process.wait().then(async result => {
      const stderr = await this.#stderr.catch(() => "")
      const detail = stderr.trim().length === 0 ? "" : `: ${stderr.trim()}`
      throw new Error(`ACP Agent process exited with code ${result.exitCode} during a turn${detail}`)
    })
    return await Promise.race([turnAttempt, exited])
  }

  async abort(): Promise<void> {
    this.#observability.event(this.#observability.currentTrace(), "acp.session.cancel", {
      sessionId: this.#session.sessionId,
    })
    await this.#connection.agent.notify(methods.agent.session.cancel, {
      sessionId: this.#session.sessionId,
    })
  }

  async close(): Promise<void> {
    this.#closePromise ??= this.#close()
    await this.#closePromise
  }

  async #close(): Promise<void> {
    // Stop accepting session updates before process cleanup. dispose() and
    // connection.close() do not claim the underlying process has exited.
    this.#session.dispose()
    this.#connection.close()
    const errors: unknown[] = []

    try {
      await this.#process.kill()
    } catch (error) {
      errors.push(error)
    }

    // wait() may reject because kill() intentionally ended the process. The
    // turn already owns unexpected exit failures, so cleanup only adds stderr
    // drain failures to its result.
    const [, stderr] = await Promise.allSettled([this.#process.wait(), this.#stderr])
    if (stderr.status === "rejected") errors.push(stderr.reason)

    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "ACP session cleanup failed")
  }
}

function structuredOutputReminder(instruction: string, jsonSchema: Readonly<Record<string, unknown>>): string {
  return [
    "The previous turn ended without submitting a valid structured result.",
    instruction,
    "Call the structured-result Tool now. Do not continue the analysis or answer only with message text.",
    `The required result must match this JSON Schema:\n${JSON.stringify(jsonSchema, null, 2)}`,
  ].join("\n\n")
}

/**
 * Consumes one ACP prompt turn without dropping progress updates.
 *
 * ActiveSession has one ordered update queue. This function must remain its
 * only consumer for the turn: mixing readText() and nextUpdate() would split
 * messages between consumers and make trace order nondeterministic.
 */
export async function runAcpPrompt(
  session: Pick<ActiveSession, "nextUpdate" | "prompt" | "sessionId">,
  prompt: string,
  context: AgentExecutionContext
): Promise<string> {
  const observability = agentObservabilityServices(context)
  const trace = observability.currentTrace()
  observability.event(trace, "acp.session.prompt.submitted", { sessionId: session.sessionId }, { prompt })

  const completion = session.prompt(prompt, { cancellationSignal: context.signal }).then(
    response => ({ response }),
    error => ({ error })
  )
  let text = ""

  let message = await session.nextUpdate()

  while (message.kind !== "stop") {
    observability.event(
      trace,
      "acp.session.update",
      {
        sessionId: message.notification.sessionId,
        sessionUpdate: message.update.sessionUpdate,
        ...(message.update.sessionUpdate === "tool_call" && typeof message.update.name === "string"
          ? { toolName: message.update.name }
          : {}),
      },
      observability.sensitiveAttribute("update", message.update)
    )

    if (message.update.sessionUpdate === "agent_message_chunk" && message.update.content.type === "text") {
      text += message.update.content.text
    }

    message = await session.nextUpdate()
  }

  // The SDK queues the same prompt completion as the terminal stop message.
  // Await the request promise so transport rejection keeps its original error.
  const outcome = await completion
  if ("error" in outcome) throw outcome.error
  const response = outcome.response

  const attributes = {
    ...(response.usage === undefined || response.usage === null ? {} : { usage: JSON.stringify(response.usage) }),
    sessionId: session.sessionId,
    stopReason: response.stopReason,
  }
  observability.event(trace, "acp.session.prompt.completed", attributes)
  observability.addSpanEndAttributes(trace, attributes)

  return text
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
