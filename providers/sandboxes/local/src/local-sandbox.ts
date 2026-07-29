import { execFile } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

import {
  AbstractSandboxProvider,
  defineSandboxProvider,
  SandboxCommand,
  type ProvisionedSandbox,
  type SandboxAcquireRequest,
  type SandboxExecResult,
  type SandboxProvider,
  type SandboxRuntime,
} from "@aml-jsx/sdk"

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/**
 * Trusted host-process configuration for `localSandbox()`.
 */
export interface LocalSandboxOptions {
  readonly maxOutputBytes?: number
  readonly setup?: string
  readonly workspace?: string
}

interface ParsedLocalSandboxOptions {
  readonly maxOutputBytes: number
  readonly setup?: string
  readonly workspace?: string
}

interface LocalSandboxHandle {
  readonly directory: string
  readonly kind: "local"
}

interface LocalSandboxResource {
  readonly root: string
  readonly workspace: string
}

/**
 * Runs Sandbox commands as ordinary host processes in one Workspace.
 *
 * This provider is a composition and development proof, not an isolation
 * boundary. Use Docker or a remote provider for untrusted commands.
 */
export function localSandbox(options: LocalSandboxOptions = {}): Readonly<SandboxProvider<LocalSandboxHandle>> {
  return defineSandboxProvider(new LocalSandboxProvider(parseOptions(options)))
}

class LocalSandboxProvider
  extends AbstractSandboxProvider<"local", LocalSandboxHandle, LocalSandboxResource>
  implements SandboxProvider<LocalSandboxHandle>
{
  readonly #options: Readonly<ParsedLocalSandboxOptions>

  constructor(options: Readonly<ParsedLocalSandboxOptions>) {
    super("local")
    this.#options = options
  }

  protected async provision(
    request: SandboxAcquireRequest
  ): Promise<Readonly<ProvisionedSandbox<LocalSandboxHandle, LocalSandboxResource>>> {
    const workspaceDirectory = request.workspace?.directory ?? this.#options.workspace

    if (workspaceDirectory === undefined) {
      throw new TypeError("Local Sandbox requires an active Workspace or configured workspace")
    }

    const workspace = await realpath(workspaceDirectory)
    const root = await resolveDirectory(workspace, request.root, workspace, "root")
    await resolveDirectory(workspace, request.cwd, root, "cwd")
    request.signal.throwIfAborted()

    return Object.freeze({
      handle: Object.freeze({
        directory: root,
        kind: "local" as const,
      }),
      id: `local:${randomUUID()}`,
      resource: Object.freeze({ root, workspace }),
    })
  }

  protected createRuntime(
    provisioned: Readonly<ProvisionedSandbox<LocalSandboxHandle, LocalSandboxResource>>,
    request: SandboxAcquireRequest
  ): Readonly<SandboxRuntime> {
    return createRuntime(
      request,
      provisioned.resource.workspace,
      provisioned.resource.root,
      this.#options.maxOutputBytes
    )
  }

  protected override async initialize(
    _provisioned: Readonly<ProvisionedSandbox<LocalSandboxHandle, LocalSandboxResource>>,
    runtime: Readonly<SandboxRuntime>,
    request: SandboxAcquireRequest
  ): Promise<void> {
    if (this.#options.setup === undefined) {
      return
    }

    const result = await runtime.exec("sh", ["-lc", this.#options.setup], {
      cwd: request.cwd,
      signal: request.signal,
    })

    if (result.exitCode !== 0) {
      throw new Error(`Local Sandbox setup failed with exit code ${result.exitCode}: ${result.stderr.trim()}`)
    }
  }

  protected async releaseResource(): Promise<void> {}
}

/**
 * Creates the narrow runtime over one validated local Workspace root.
 */
function createRuntime(
  request: SandboxAcquireRequest,
  workspace: string,
  root: string,
  maxOutputBytes: number
): Readonly<SandboxRuntime> {
  const runtime: SandboxRuntime = {
    access: request.access,
    cwd: request.cwd,
    async exec(command, args = [], options = {}) {
      if (request.access !== "read-write") {
        throw new Error("Local Sandbox cannot execute under read-only access because host processes cannot enforce it")
      }

      const captured = SandboxCommand.from(request, command, args, options)
      const cwd = await resolveDirectory(workspace, captured.cwd, root, "command cwd")
      return await execute(captured, cwd, maxOutputBytes)
    },
    root: request.root,
  }

  return Object.freeze(runtime)
}

/**
 * Executes one literal host command with Node's bounded child-process API.
 */
async function execute(
  command: SandboxCommand,
  cwd: string,
  maxOutputBytes: number
): Promise<Readonly<SandboxExecResult>> {
  return await new Promise<Readonly<SandboxExecResult>>((resolve, reject) => {
    const child = execFile(
      command.command,
      [...command.args],
      {
        cwd,
        encoding: "utf8",
        // Some coding Agents resolve their project from PWD before asking the
        // operating system for cwd. Keep both views on the attached Workspace.
        env: { ...process.env, ...command.env, PWD: cwd },
        maxBuffer: maxOutputBytes,
        signal: command.signal,
        timeout: command.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (command.signal.aborted) {
          reject(command.signal.reason)
          return
        }

        const exitCode = error === null ? 0 : error.code

        if (typeof exitCode !== "number") {
          reject(new Error(`Local Sandbox command failed: ${error?.message ?? "unknown failure"}`, { cause: error }))
          return
        }

        resolve(
          Object.freeze({
            exitCode,
            stderr,
            stdout,
          })
        )
      }
    )

    // The common runtime has no stdin channel. Close the implicit pipe so
    // programs that probe piped input observe EOF instead of waiting forever.
    child.stdin?.end()
  })
}

/**
 * Resolves one logical AML path and rejects real symlink escapes.
 */
async function resolveDirectory(
  workspace: string,
  logicalPath: string,
  boundary: string,
  label: string
): Promise<string> {
  const target = await realpath(path.resolve(workspace, ...logicalPath.split("/")))
  assertPathWithin(boundary, target, `Local Sandbox ${label}`)

  if (!(await stat(target)).isDirectory()) {
    throw new TypeError(`Local Sandbox ${label} must be a directory`)
  }

  return target
}

function assertPathWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate)

  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new TypeError(`${label} resolves outside its configured boundary`)
  }
}

function parseOptions(value: LocalSandboxOptions): Readonly<ParsedLocalSandboxOptions> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Local Sandbox options must be an object")
  }

  const maxOutputBytes = value.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError("Local Sandbox maxOutputBytes must be a positive safe integer")
  }

  const setup = optionalNormalizedString(value.setup, "Local Sandbox setup")
  const workspace = optionalNormalizedString(value.workspace, "Local Sandbox workspace")

  return Object.freeze({
    maxOutputBytes,
    ...(setup === undefined ? {} : { setup }),
    ...(workspace === undefined ? {} : { workspace: path.resolve(workspace) }),
  })
}

function optionalNormalizedString(value: string | undefined, label: string): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty normalized string`)
  }

  return value
}
