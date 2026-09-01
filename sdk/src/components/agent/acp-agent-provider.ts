import { randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { McpServer } from "@agentclientprotocol/sdk"

import type { AmlTraceIdentity } from "../../core/trace-identity.js"
import type { AgentMcpServer } from "../mcp/aml-mcp-server.js"
import type { SandboxProcess, SandboxProcessExit } from "../sandbox/sandbox-runtime.js"
import { supportsSandboxRuntime } from "../sandbox/sandbox-runtime.js"
import type { AgentExecutionContext } from "./agent-execution-context.js"
import type { AgentProvider } from "./agent-provider.js"
import type { AgentProviderSession, AgentProviderTurn } from "./agent-provider-session.js"
import type { AgentRequest } from "./agent-request.js"
import type { AgentResponse } from "./agent-response.js"
import { agentObservabilityServices, type AgentObservabilityServices } from "./agent-observability-services.js"
import { agentStructuredOutputServices } from "./agent-structured-output-services.js"
import { AbstractAgentProvider } from "./abstract-agent-provider.js"
import { defineAgentProvider } from "./define-agent-provider.js"
import { AcpMcpBridge } from "./acp-mcp-bridge.js"
import { AcpMcpRelay } from "./acp-mcp-relay.js"
import { materializeSandboxFiles } from "./sandbox-file-materializer.js"
import {
  openAcpSession,
  type AcpPermissionPolicy,
  type AcpSessionConfiguration,
  type AcpSessionTextTransform,
} from "./acp-agent-session.js"
import { spawnLocalProcess } from "./spawn-local-process.js"

/**
 * Execution environment prepared once for an ACP Agent profile.
 */
export interface AcpAgentLaunchContext {
  /**
   * Invocation-owned MCP server hosting AML JavaScript Tools and structured output.
   *
   * Omitted when the request grants no JavaScript Tools and asks for no
   * structured output.
   */
  readonly amlMcpServerName?: string

  /** Physical working directory in the host process or active Sandbox. */
  readonly cwd: string

  /** Whether the launched process inherits the AML host's `process.env`. */
  readonly inheritsProcessEnvironment: boolean

  /** ACP transport descriptors already mapped from the Agent's MCP grants. */
  readonly mcpServers: readonly McpServer[]

  /** Complete provider-neutral Agent request used to derive vendor settings. */
  readonly request: Readonly<AgentRequest>

  /**
   * Fresh writable directory owned by this invocation.
   *
   * Profiles may place configuration and credential-pointer files here. AML
   * removes the directory during session cleanup.
   */
  readonly stateDirectory: string
}

/**
 * Invocation-private file requested by an Agent profile.
 */
export interface AcpAgentLaunchFile {
  /** UTF-8 contents written before the Agent process starts. */
  readonly content: string

  /** Whether AML adds executable permission after writing; defaults to `false`. */
  readonly executable?: boolean

  /** Portable relative path beneath the invocation `stateDirectory`. */
  readonly path: string
}

/**
 * Process and protocol settings supplied by one thin ACP Agent profile.
 */
export interface AcpAgentLaunch {
  /** Literal process arguments; defaults to an empty array. */
  readonly args?: readonly string[]

  /** ACP authentication method selected after initialization, when required. */
  readonly authenticationMethodId?: string

  /** Executable started through the host or active Sandbox process runtime. */
  readonly command: string

  /** ACP session configuration values applied before prompting. */
  readonly configuration?: readonly AcpSessionConfiguration[]

  /** Environment entries supplied to the launched process. */
  readonly env?: Readonly<Record<string, string>>

  /** Invocation-private files materialized before process startup. */
  readonly files?: readonly AcpAgentLaunchFile[]

  /** Text prepended only to the initial authored prompt, when configured. */
  readonly initialPromptPrefix?: string

  /** Maps AML permission requests onto ACP permission decisions. */
  readonly permissionPolicy: AcpPermissionPolicy

  /**
   * Complete ACP MCP list used for session creation.
   *
   * Omission uses the mapped `AcpAgentLaunchContext.mcpServers`; supplying this
   * field replaces that list and is useful only for profile-specific mapping.
   */
  readonly sessionMcpServers?: readonly McpServer[]

  /** Profile-specific instruction used for AML's structured-result Tool turn. */
  readonly structuredOutputInstruction?: string

  /** Optional final ACP text transformation applied before AML returns a turn. */
  readonly transformText?: AcpSessionTextTransform
}

/**
 * Agent-specific configuration retained outside the shared ACP lifecycle.
 */
export interface AcpAgentProfile<Name extends string> {
  /** Literal provider name exposed by the resulting Agent provider. */
  readonly name: Name

  /** Provider-native MCP names that share the launched Agent's namespace. */
  readonly reservedMcpServerNames?: readonly string[]

  /** Declares that `createLaunch()` maps staged packages into native discovery. */
  readonly skillDiscovery?: "native"

  /**
   * Host working directory used outside a Sandbox.
   *
   * `undefined` defaults to `process.cwd()`. An active Sandbox supplies its own
   * physical cwd and ignores this host-only setting.
   */
  readonly workingDirectory: string | undefined

  /** Builds invocation-specific process and ACP settings without starting work. */
  createLaunch(context: Readonly<AcpAgentLaunchContext>): Readonly<AcpAgentLaunch>

  /** Reports whether this profile can map one provider-native MCP server name. */
  supportsNamedMcpServer?(name: string): boolean
}

/**
 * Shared built-in coding-Agent provider implemented through one ACP lifecycle.
 */
class AcpAgentProvider<Name extends string> extends AbstractAgentProvider<Name> {
  readonly #profile: Readonly<AcpAgentProfile<Name>>
  readonly skillDiscovery?: "native"

  constructor(profile: Readonly<AcpAgentProfile<Name>>) {
    super(profile.name)
    this.#profile = profile

    if (profile.skillDiscovery !== undefined) {
      this.skillDiscovery = profile.skillDiscovery
    }
  }

  override supportsSandbox(sandbox: NonNullable<AgentExecutionContext["sandbox"]>): boolean {
    return supportsSandboxRuntime(sandbox)
  }

  protected async openSession(request: AgentRequest, context: AgentExecutionContext): Promise<AgentProviderSession> {
    const observability = agentObservabilityServices(context)
    const mcpServers = [...mapMcpServers(request.mcpServers, this.#profile)]
    const javaScriptTools = request.tools
    let amlMcpServerName: string | undefined
    let bridge: AcpMcpBridge | undefined
    let execution: Readonly<AcpExecution> | undefined
    let relay: AcpMcpRelay | undefined

    try {
      if (javaScriptTools.length > 0 || request.output !== undefined) {
        bridge = new AcpMcpBridge(
          javaScriptTools,
          request.output,
          context,
          request.output === undefined ? undefined : agentStructuredOutputServices(context),
          [
            ...request.mcpServers.map(server => (server.kind === "named" ? server.name : server.definition.name)),
            ...(this.#profile.reservedMcpServerNames ?? []),
          ]
        )
        let connection = await bridge.start(context.signal)

        if (context.sandbox !== undefined) {
          const started = await AcpMcpRelay.start(
            context.sandbox.lease.runtime,
            context.sandbox.cwd,
            connection,
            context.signal
          )
          connection = started.connection
          relay = started.relay
        }

        amlMcpServerName = connection.name
        mcpServers.push(bridge.asMcpServer(connection))
      }

      execution = await prepareExecution(this.#profile, request, mcpServers, context, amlMcpServerName)
      const session = await openAcpSession({
        ...(execution.launch.authenticationMethodId === undefined
          ? {}
          : { authenticationMethodId: execution.launch.authenticationMethodId }),
        ...(execution.launch.configuration === undefined ? {} : { configuration: execution.launch.configuration }),
        cwd: execution.cwd,
        ...(execution.launch.initialPromptPrefix === undefined
          ? {}
          : { initialPromptPrefix: execution.launch.initialPromptPrefix }),
        mcpServers: execution.launch.sessionMcpServers ?? mcpServers,
        observability,
        permissionPolicy: execution.launch.permissionPolicy,
        process: execution.process,
        signal: context.signal,
        ...(bridge === undefined ? {} : { structuredOutput: bridge }),
        ...(execution.launch.structuredOutputInstruction === undefined
          ? {}
          : { structuredOutputInstruction: execution.launch.structuredOutputInstruction }),
        ...(execution.launch.transformText === undefined ? {} : { transformText: execution.launch.transformText }),
      })
      return new OwnedAcpSession(session, invocationCleanup(execution.cleanup, bridge, relay), this.name)
    } catch (error) {
      await invocationCleanup(execution?.cleanup, bridge, relay)().catch(() => undefined)
      throw error
    }
  }
}

/**
 * Defines an immutable Agent provider backed by AML's shared ACP lifecycle.
 *
 * The shared implementation owns process startup, Sandbox execution, MCP Tool
 * bridging, ordered turns, cancellation, structured output, and cleanup. The
 * profile owns only vendor-specific launch and capability mapping.
 */
export function defineAcpAgentProvider<Name extends string>(
  profile: Readonly<AcpAgentProfile<Name>>
): Readonly<
  AgentProvider & {
    /** Exact provider name captured from the ACP profile. */
    readonly name: Name
  }
> {
  return defineAgentProvider(new AcpAgentProvider(profile))
}

interface AcpExecution {
  readonly cleanup: () => Promise<void>
  readonly cwd: string
  readonly launch: Readonly<AcpAgentLaunch>
  readonly process: Readonly<SandboxProcess>
}

async function prepareExecution<Name extends string>(
  profile: Readonly<AcpAgentProfile<Name>>,
  request: Readonly<AgentRequest>,
  mcpServers: readonly McpServer[],
  context: AgentExecutionContext,
  amlMcpServerName: string | undefined
): Promise<Readonly<AcpExecution>> {
  const observability = agentObservabilityServices(context)
  const sandbox = context.sandbox

  if (sandbox === undefined) {
    const cwd = await realpath(profile.workingDirectory ?? process.cwd())
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "aml-acp-"))
    const cleanup = async (): Promise<void> => await rm(stateDirectory, { force: true, recursive: true })

    try {
      const launch = profile.createLaunch({
        ...(amlMcpServerName === undefined ? {} : { amlMcpServerName }),
        cwd,
        inheritsProcessEnvironment: true,
        mcpServers,
        request,
        stateDirectory,
      })
      await writeLocalLaunchFiles(stateDirectory, launch.files ?? [])

      // Process identity is deliberately opaque. Local currently returns a PID-
      // backed id, but traces and consumers must treat it like any remote id.
      traceProcess(context, "spawn_requested", undefined, launch.command)
      const processHandle = await spawnLocalProcess(launch.command, launch.args ?? [], {
        cwd,
        ...(launch.env === undefined ? {} : { env: launch.env }),
        signal: context.signal,
      })
      traceProcess(context, "started", processHandle.id, launch.command)
      return Object.freeze({
        cleanup,
        cwd,
        launch,
        process: new TracedSandboxProcess(processHandle, observability),
      })
    } catch (error) {
      await cleanup().catch(() => undefined)
      throw error
    }
  }

  const pwd = await sandbox.lease.runtime.exec("pwd", [], {
    cwd: sandbox.cwd,
    signal: context.signal,
  })

  if (pwd.exitCode !== 0) {
    throw new Error(`Agent provider "${profile.name}" could not resolve its Sandbox cwd: ${pwd.stderr.trim()}`)
  }

  const cwd = pwd.stdout.trim()
  if (cwd.length === 0) {
    throw new Error(`Agent provider "${profile.name}" Sandbox cwd resolved to an empty path`)
  }

  const stateDirectory = `/tmp/aml-acp-${randomUUID()}`
  const prepare = await sandbox.lease.runtime.exec("mkdir", ["-p", "--", stateDirectory], {
    signal: context.signal,
  })

  if (prepare.exitCode !== 0) {
    throw new Error(`Agent provider "${profile.name}" could not prepare writable state: ${prepare.stderr.trim()}`)
  }

  const cleanup = async (): Promise<void> => {
    const result = await sandbox.lease.runtime.exec("rm", ["-rf", "--", stateDirectory])
    if (result.exitCode !== 0) {
      throw new Error(`Agent provider "${profile.name}" state cleanup failed: ${result.stderr.trim()}`)
    }
  }

  try {
    const launch = profile.createLaunch({
      ...(amlMcpServerName === undefined ? {} : { amlMcpServerName }),
      cwd,
      inheritsProcessEnvironment: false,
      mcpServers,
      request,
      stateDirectory,
    })
    await materializeSandboxFiles(sandbox.lease.runtime, stateDirectory, launch.files ?? [], context.signal)

    // The Sandbox provider decides whether this process is local, containerized,
    // or remote; the portable trace contract only records its opaque handle.
    traceProcess(context, "spawn_requested", undefined, launch.command)
    const processHandle = await sandbox.lease.runtime.spawn(launch.command, launch.args ?? [], {
      cwd: sandbox.cwd,
      ...(launch.env === undefined ? {} : { env: launch.env }),
      signal: context.signal,
    })
    traceProcess(context, "started", processHandle.id, launch.command)
    return Object.freeze({
      cleanup,
      cwd,
      launch,
      process: new TracedSandboxProcess(processHandle, observability),
    })
  } catch (error) {
    await cleanup().catch(() => undefined)
    throw error
  }
}

/**
 * Preserves the SandboxProcess boundary while tracing its provider-owned
 * lifecycle. Repeated wait() and kill() calls share the same underlying work.
 */
class TracedSandboxProcess implements SandboxProcess {
  readonly #observability: AgentObservabilityServices
  readonly #process: Readonly<SandboxProcess>
  readonly #sessionTrace: AmlTraceIdentity
  #completion: Promise<Readonly<SandboxProcessExit>> | undefined
  #killRequest: Promise<void> | undefined
  readonly id: string
  readonly stdin: WritableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>

  constructor(process: Readonly<SandboxProcess>, observability: AgentObservabilityServices) {
    this.#observability = observability
    this.#process = process
    this.#sessionTrace = observability.currentTrace()
    this.id = process.id
    this.stdin = process.stdin
    this.stderr = process.stderr
    this.stdout = process.stdout
  }

  kill(): Promise<void> {
    this.#killRequest ??= this.#requestKill()
    return this.#killRequest
  }

  wait(): Promise<Readonly<SandboxProcessExit>> {
    this.#completion ??= this.#observeExit()
    return this.#completion
  }

  async #requestKill(): Promise<void> {
    const trace = this.#observability.currentTrace()
    this.#observability.event(trace, "sandbox.process", {
      "execution.id": this.id,
      state: "kill_requested",
    })

    await this.#process.kill()

    this.#observability.event(trace, "sandbox.process", {
      "execution.id": this.id,
      state: "kill_completed",
    })
  }

  async #observeExit(): Promise<Readonly<SandboxProcessExit>> {
    try {
      const result = await this.#process.wait()
      this.#observability.event(this.#sessionTrace, "sandbox.process", {
        "execution.id": this.id,
        exitCode: result.exitCode,
        state: "exited",
      })
      return result
    } catch (error) {
      // A failed wait cannot prove the process exited. Report unexpected
      // observation failures, but do not turn an intentional kill into noise.
      if (this.#killRequest === undefined) {
        this.#observability.event(this.#sessionTrace, "sandbox.process", {
          "execution.id": this.id,
          state: "wait_failed",
        })
      }

      throw error
    }
  }
}

function traceProcess(
  context: AgentExecutionContext,
  state: "spawn_requested" | "started",
  executionId: string | undefined,
  command: string
): void {
  const observability = agentObservabilityServices(context)

  // Executable names can disclose private infrastructure, so metadata-only
  // traces retain lifecycle state and identity but redact the command.
  observability.event(
    observability.currentTrace(),
    "sandbox.process",
    { ...(executionId === undefined ? {} : { "execution.id": executionId }), state },
    { command }
  )
}

async function writeLocalLaunchFiles(stateDirectory: string, files: readonly AcpAgentLaunchFile[]): Promise<void> {
  for (const file of files) {
    const destination = launchFileDestination(stateDirectory, file.path)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, file.content, {
      encoding: "utf8",
      mode: file.executable === true ? 0o700 : 0o600,
    })
    if (file.executable === true) await chmod(destination, 0o700)
  }
}

function launchFileDestination(stateDirectory: string, relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath !== relativePath.trim() ||
    relativePath.includes("\0") ||
    path.isAbsolute(relativePath)
  ) {
    throw new TypeError("ACP Agent launch file path must be a normalized relative path")
  }

  const destination = path.resolve(stateDirectory, relativePath)
  if (destination !== stateDirectory && !destination.startsWith(`${stateDirectory}${path.sep}`)) {
    throw new TypeError("ACP Agent launch file path must remain inside its state directory")
  }

  return destination
}

function mapMcpServers<Name extends string>(
  servers: readonly AgentMcpServer[],
  profile: Readonly<AcpAgentProfile<Name>>
): readonly McpServer[] {
  return Object.freeze(
    servers.flatMap((server): McpServer[] => {
      if (server.kind === "named") {
        if (profile.supportsNamedMcpServer?.(server.name) !== true) {
          throw new TypeError(`Agent provider "${profile.name}" cannot verify named MCP server "${server.name}"`)
        }

        // Named servers are already configured inside the Agent and therefore
        // do not produce a portable session/new descriptor.
        return []
      }

      const { name, transport } = server.definition

      if (transport.type === "streamable-http") {
        return [
          {
            headers: Object.entries(transport.headers ?? {}).map(([headerName, value]) => ({
              name: headerName,
              value,
            })),
            name,
            type: "http",
            url: transport.url,
          },
        ]
      }

      if (transport.cwd !== undefined) {
        throw new TypeError(
          `ACP stdio MCP server "${name}" cannot preserve its configured cwd because ACP has no stdio cwd field`
        )
      }

      return [
        {
          args: [...(transport.args ?? [])],
          command: transport.command,
          env: Object.entries(transport.env ?? {}).map(([environmentName, value]) => ({
            name: environmentName,
            value,
          })),
          name,
        },
      ]
    })
  )
}

class OwnedAcpSession implements AgentProviderSession {
  readonly #cleanup: () => Promise<void>
  readonly #providerName: string
  readonly #session: AgentProviderSession
  #closePromise: Promise<void> | undefined

  constructor(session: AgentProviderSession, cleanup: () => Promise<void>, providerName: string) {
    this.#cleanup = cleanup
    this.#providerName = providerName
    this.#session = session
  }

  async runTurn(turn: Readonly<AgentProviderTurn>, context: AgentExecutionContext): Promise<AgentResponse> {
    return await this.#session.runTurn(turn, context)
  }

  async abort(): Promise<void> {
    await this.#session.abort?.()
  }

  async close(): Promise<void> {
    this.#closePromise ??= this.#close()
    await this.#closePromise
  }

  async #close(): Promise<void> {
    const errors: unknown[] = []

    try {
      await this.#session.close()
    } catch (error) {
      errors.push(error)
    }

    try {
      await this.#cleanup()
    } catch (error) {
      errors.push(error)
    }

    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, `Agent provider "${this.#providerName}" ACP session cleanup failed`)
    }
  }
}

async function closeOwnedResources(resources: readonly (() => Promise<void>)[]): Promise<void> {
  const errors: unknown[] = []

  for (const close of resources) {
    try {
      await close()
    } catch (error) {
      errors.push(error)
    }
  }

  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, "ACP invocation resource cleanup failed")
}

function invocationCleanup(
  executionCleanup: (() => Promise<void>) | undefined,
  bridge: AcpMcpBridge | undefined,
  relay: AcpMcpRelay | undefined
): () => Promise<void> {
  const resources: Array<() => Promise<void>> = []

  if (relay !== undefined) {
    resources.push(async () => await relay.close())
  }

  if (bridge !== undefined) {
    resources.push(async () => await bridge.close())
  }

  if (executionCleanup !== undefined) {
    resources.push(executionCleanup)
  }
  return async () => await closeOwnedResources(resources)
}
