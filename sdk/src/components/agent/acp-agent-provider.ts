import { randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { McpServer } from "@agentclientprotocol/sdk"

import type { AgentMcpServer } from "../mcp/aml-mcp-server.js"
import type { SandboxProcess } from "../sandbox/sandbox-runtime.js"
import { supportsSandboxRuntime } from "../sandbox/sandbox-runtime.js"
import type { AgentExecutionContext } from "./agent-execution-context.js"
import type { AgentProvider } from "./agent-provider.js"
import type { AgentProviderSession, AgentProviderTurn } from "./agent-provider-session.js"
import type { AgentRequest } from "./agent-request.js"
import type { AgentResponse } from "./agent-response.js"
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
  readonly cwd: string
  readonly mcpServers: readonly McpServer[]
  readonly request: Readonly<AgentRequest>
  readonly stateDirectory: string
}

/**
 * Invocation-private file requested by an Agent profile.
 */
export interface AcpAgentLaunchFile {
  readonly content: string
  readonly executable?: boolean
  readonly path: string
}

/**
 * Process and protocol settings supplied by one thin ACP Agent profile.
 */
export interface AcpAgentLaunch {
  readonly args?: readonly string[]
  readonly authenticationMethodId?: string
  readonly command: string
  readonly configuration?: readonly AcpSessionConfiguration[]
  readonly env?: Readonly<Record<string, string>>
  readonly files?: readonly AcpAgentLaunchFile[]
  readonly initialPromptPrefix?: string
  readonly permissionPolicy: AcpPermissionPolicy
  readonly sessionMcpServers?: readonly McpServer[]
  readonly structuredOutputInstruction?: string
  readonly transformText?: AcpSessionTextTransform
}

/**
 * Agent-specific configuration retained outside the shared ACP lifecycle.
 */
export interface AcpAgentProfile<Name extends string> {
  readonly name: Name
  readonly workingDirectory: string | undefined

  createLaunch(context: Readonly<AcpAgentLaunchContext>): Readonly<AcpAgentLaunch>
  supportsNamedMcpServer?(name: string): boolean
}

/**
 * Shared built-in coding-Agent provider implemented through one ACP lifecycle.
 */
class AcpAgentProvider<Name extends string> extends AbstractAgentProvider<Name> {
  readonly #profile: Readonly<AcpAgentProfile<Name>>

  constructor(profile: Readonly<AcpAgentProfile<Name>>) {
    super(profile.name)
    this.#profile = profile
  }

  override supportsSandbox(sandbox: NonNullable<AgentExecutionContext["sandbox"]>): boolean {
    return supportsSandboxRuntime(sandbox)
  }

  protected async openSession(request: AgentRequest, context: AgentExecutionContext): Promise<AgentProviderSession> {
    const mcpServers = [...mapMcpServers(request.mcpServers, this.#profile)]
    const javaScriptTools = request.tools
    let bridge: AcpMcpBridge | undefined
    let execution: Readonly<AcpExecution> | undefined
    let relay: AcpMcpRelay | undefined

    try {
      if (javaScriptTools.length > 0 || request.output !== undefined) {
        bridge = new AcpMcpBridge(javaScriptTools, request.output, context)
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

        mcpServers.push(bridge.asMcpServer(connection))
      }

      execution = await prepareExecution(this.#profile, request, mcpServers, context)
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
      await execution?.process.kill().catch(() => undefined)
      await invocationCleanup(execution?.cleanup, bridge, relay)().catch(() => undefined)
      throw error
    }
  }
}

/**
 * Defines an Agent provider backed by AML's shared ACP lifecycle.
 */
export function defineAcpAgentProvider<Name extends string>(
  profile: Readonly<AcpAgentProfile<Name>>
): Readonly<AgentProvider & { readonly name: Name }> {
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
  context: AgentExecutionContext
): Promise<Readonly<AcpExecution>> {
  const sandbox = context.sandbox

  if (sandbox === undefined) {
    const cwd = await realpath(profile.workingDirectory ?? process.cwd())
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "aml-acp-"))
    const cleanup = async (): Promise<void> => await rm(stateDirectory, { force: true, recursive: true })

    try {
      const launch = profile.createLaunch({ cwd, mcpServers, request, stateDirectory })
      await writeLocalLaunchFiles(stateDirectory, launch.files ?? [])
      const processHandle = await spawnLocalProcess(launch.command, launch.args ?? [], {
        cwd,
        ...(launch.env === undefined ? {} : { env: launch.env }),
        signal: context.signal,
      })
      return Object.freeze({ cleanup, cwd, launch, process: processHandle })
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
    const launch = profile.createLaunch({ cwd, mcpServers, request, stateDirectory })
    await materializeSandboxFiles(sandbox.lease.runtime, stateDirectory, launch.files ?? [], context.signal)
    const processHandle = await sandbox.lease.runtime.spawn(launch.command, launch.args ?? [], {
      cwd: sandbox.cwd,
      ...(launch.env === undefined ? {} : { env: launch.env }),
      signal: context.signal,
    })
    return Object.freeze({ cleanup, cwd, launch, process: processHandle })
  } catch (error) {
    await cleanup().catch(() => undefined)
    throw error
  }
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
