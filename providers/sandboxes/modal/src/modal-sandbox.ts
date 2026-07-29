import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { cp, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { ModalClient, type ModalClientParams, type Sandbox as ModalSdkSandbox, type SandboxCreateParams } from "modal"
import {
  AbstractSandboxProvider,
  defineSandboxProvider,
  SandboxCommand,
  type ProvisionedSandbox,
  type SandboxAcquireRequest,
  type SandboxProvider,
  type SandboxRuntime,
} from "@aml-jsx/sdk"

const DEFAULT_APP_NAME = "aml-jsx"
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const GUEST_ROOT = "/workspace"
const execFileAsync = promisify(execFile)

/**
 * Provider-native Modal configuration plus AML lifecycle conveniences.
 */
export interface ModalSandboxOptions {
  readonly appName?: string
  readonly client?: ModalClient
  readonly config?: ModalClientParams
  readonly create?: SandboxCreateParams
  readonly image: string
  readonly maxOutputBytes?: number
  readonly setup?: string
  readonly workspace?: string
}

interface ParsedModalSandboxOptions extends ModalSandboxOptions {
  readonly appName: string
  readonly maxOutputBytes: number
}

export interface ModalSandboxHandle {
  readonly kind: "modal"
  readonly sandbox: ModalSdkSandbox
}

interface ModalSandboxResource {
  released: boolean
  readonly sandbox: ModalSdkSandbox
  readonly source: string
}

/**
 * Creates disposable Modal environments and transfers one Workspace into
 * `/workspace` for each acquisition.
 */
export function modalSandbox(options: ModalSandboxOptions): Readonly<SandboxProvider<ModalSandboxHandle>> {
  return defineSandboxProvider(new ModalSandboxProvider(parseOptions(options)))
}

class ModalSandboxProvider
  extends AbstractSandboxProvider<"modal", ModalSandboxHandle, ModalSandboxResource>
  implements SandboxProvider<ModalSandboxHandle>
{
  #client: ModalClient | undefined
  readonly #options: Readonly<ParsedModalSandboxOptions>

  constructor(options: Readonly<ParsedModalSandboxOptions>) {
    super("modal")
    this.#options = options
    this.#client = options.client
  }

  protected async provision(
    request: SandboxAcquireRequest
  ): Promise<Readonly<ProvisionedSandbox<ModalSandboxHandle, ModalSandboxResource>>> {
    const client = this.#getClient()
    const source = await resolveSource(request, this.#options.workspace)
    const app = await abortable(client.apps.fromName(this.#options.appName, { createIfMissing: true }), request.signal)
    const image = client.images.fromRegistry(this.#options.image)
    const creation = client.sandboxes.create(app, image, this.#options.create)
    let sandbox: ModalSdkSandbox

    try {
      sandbox = await abortable(creation, request.signal)
    } catch (cause) {
      // Creation cannot currently accept an AbortSignal. Reclaim a Sandbox
      // that finishes provisioning after its AML evaluation was cancelled.
      void creation.then(
        async created => await created.terminate(),
        () => undefined
      )
      throw cause
    }

    const resource: ModalSandboxResource = {
      released: false,
      sandbox,
      source,
    }

    try {
      await hydrateWorkspace(sandbox, source, this.#options.maxOutputBytes, request.signal)
      request.signal.throwIfAborted()
      return Object.freeze({
        handle: Object.freeze({
          kind: "modal" as const,
          sandbox,
        }),
        id: sandbox.sandboxId,
        resource,
      })
    } catch (cause) {
      try {
        await this.#destroy(resource)
      } catch (cleanupError) {
        throw new AggregateError([cause, cleanupError], "Modal Sandbox acquisition and cleanup failed")
      }

      throw cause
    }
  }

  protected createRuntime(
    provisioned: Readonly<ProvisionedSandbox<ModalSandboxHandle, ModalSandboxResource>>,
    request: SandboxAcquireRequest
  ): Readonly<SandboxRuntime> {
    return createRuntime(
      request,
      provisioned.resource.sandbox,
      async () => await this.#destroy(provisioned.resource),
      this.#options.maxOutputBytes
    )
  }

  protected override async initialize(
    _provisioned: Readonly<ProvisionedSandbox<ModalSandboxHandle, ModalSandboxResource>>,
    runtime: Readonly<SandboxRuntime>,
    request: SandboxAcquireRequest
  ): Promise<void> {
    if (this.#options.setup === undefined) {
      return
    }

    const setup = await runtime.exec("sh", ["-lc", this.#options.setup], {
      cwd: request.cwd,
      signal: request.signal,
    })

    if (setup.exitCode !== 0) {
      throw new Error(`Modal Sandbox setup failed with exit code ${setup.exitCode}: ${setup.stderr.trim()}`)
    }
  }

  protected override async cleanupProvisioned(
    provisioned: Readonly<ProvisionedSandbox<ModalSandboxHandle, ModalSandboxResource>>
  ): Promise<void> {
    await this.#destroy(provisioned.resource)
  }

  protected async releaseResource(
    provisioned: Readonly<ProvisionedSandbox<ModalSandboxHandle, ModalSandboxResource>>,
    request: SandboxAcquireRequest
  ): Promise<void> {
    const resource = provisioned.resource

    if (resource.released) {
      return
    }

    let reconciliationError: unknown

    if (request.access === "read-write") {
      try {
        await reconcileWorkspace(resource.sandbox, resource.source, this.#options.maxOutputBytes)
      } catch (cause) {
        reconciliationError = cause
      }
    }

    try {
      await this.#destroy(resource)
    } catch (cleanupError) {
      if (reconciliationError !== undefined) {
        throw new AggregateError(
          [reconciliationError, cleanupError],
          "Modal Sandbox Workspace reconciliation and cleanup failed"
        )
      }

      throw cleanupError
    }

    if (reconciliationError !== undefined) {
      throw reconciliationError
    }
  }

  #getClient(): ModalClient {
    this.#client ??= new ModalClient(this.#options.config)
    return this.#client
  }

  async #destroy(resource: ModalSandboxResource): Promise<void> {
    if (resource.released) {
      return
    }

    resource.released = true
    await resource.sandbox.terminate()
  }
}

function createRuntime(
  request: SandboxAcquireRequest,
  sandbox: ModalSdkSandbox,
  destroy: () => Promise<void>,
  maxOutputBytes: number
): Readonly<SandboxRuntime> {
  const runtime: SandboxRuntime = {
    access: request.access,
    cwd: request.cwd,
    async exec(command, args = [], options = {}) {
      if (request.access !== "read-write") {
        throw new Error(
          "Modal Sandbox cannot execute under read-only access because its transferred Workspace is not mounted read-only"
        )
      }

      const captured = SandboxCommand.from(request, command, args, options)
      const execution = sandbox.exec([captured.command, ...captured.args], {
        env: { ...captured.env },
        stderr: "pipe",
        stdout: "pipe",
        ...(captured.timeoutMs === undefined ? {} : { timeoutMs: captured.timeoutMs }),
        workdir: guestPath(request.root, captured.cwd),
      })

      try {
        const process = await abortable(execution, captured.signal)
        // SandboxRuntime has no stdin channel. Send EOF immediately so CLIs
        // that probe piped input do not wait forever for an unreachable writer.
        await abortable(process.stdin.close(), captured.signal)
        const outputBudget = { bytes: 0 }
        const completion = Promise.all([
          readBoundedText(process.stdout, outputBudget, maxOutputBytes),
          readBoundedText(process.stderr, outputBudget, maxOutputBytes),
          process.wait(),
        ] as const)
        const [stdout, stderr, exitCode] = await abortable(completion, captured.signal)

        return Object.freeze({
          exitCode,
          stderr,
          stdout,
        })
      } catch (cause) {
        // Modal process handles do not expose cancellation. Terminate the
        // disposable Sandbox so cancelled or over-limit work cannot continue.
        try {
          await destroy()
        } catch (cleanupError) {
          throw new AggregateError([cause, cleanupError], "Modal Sandbox command and cleanup failed")
        }

        throw cause
      }
    },
    root: request.root,
  }

  return Object.freeze(runtime)
}

/**
 * Reads Modal's output streams against one shared byte budget so neither
 * stream can grow the host process without bound.
 */
async function readBoundedText(
  stream: ReadableStream<string>,
  budget: { bytes: number },
  maxOutputBytes: number
): Promise<string> {
  const reader = stream.getReader()
  const chunks: string[] = []

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        return chunks.join("")
      }

      budget.bytes += Buffer.byteLength(value)

      if (budget.bytes > maxOutputBytes) {
        throw new RangeError(`Modal Sandbox command output exceeded ${maxOutputBytes} bytes`)
      }

      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Uploads one exact archive because Workspace transfer belongs to the provider
 * lifecycle rather than the Agent-facing SandboxRuntime.
 */
async function hydrateWorkspace(
  sandbox: ModalSdkSandbox,
  source: string,
  maxOutputBytes: number,
  signal: AbortSignal
): Promise<void> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "aml-modal-upload-"))
  const archive = path.join(temporaryDirectory, "workspace.tar")
  const remoteArchive = `/tmp/aml-workspace-${randomUUID()}.tar`

  try {
    await runLocal("tar", ["-C", source, "-cf", archive, "."], maxOutputBytes)
    await abortable(sandbox.filesystem.copyFromLocal(archive, remoteArchive), signal)
    await runRemote(
      sandbox,
      [
        "sh",
        "-lc",
        `rm -rf -- '${GUEST_ROOT}' && mkdir -p -- '${GUEST_ROOT}' && tar -xf '${remoteArchive}' -C '${GUEST_ROOT}' && rm -f -- '${remoteArchive}'`,
      ],
      signal,
      "Workspace hydration",
      maxOutputBytes
    )
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
}

/**
 * Downloads the complete remote tree and mirrors additions, modifications,
 * and deletions into the active local Workspace materialization.
 */
async function reconcileWorkspace(
  sandbox: ModalSdkSandbox,
  destination: string,
  maxOutputBytes: number
): Promise<void> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "aml-modal-download-"))
  const archive = path.join(temporaryDirectory, "workspace.tar")
  const extracted = path.join(temporaryDirectory, "workspace")
  const remoteArchive = `/tmp/aml-workspace-${randomUUID()}.tar`

  try {
    await runRemote(
      sandbox,
      ["tar", "-C", GUEST_ROOT, "-cf", remoteArchive, "."],
      undefined,
      "Workspace reconciliation",
      maxOutputBytes
    )
    await sandbox.filesystem.copyToLocal(remoteArchive, archive)
    await mkdir(extracted, { recursive: true })
    await runLocal("tar", ["-C", extracted, "-xf", archive], maxOutputBytes)

    for (const entry of await readdir(destination)) {
      await rm(path.join(destination, entry), { force: true, recursive: true })
    }

    for (const entry of await readdir(extracted)) {
      await cp(path.join(extracted, entry), path.join(destination, entry), {
        preserveTimestamps: true,
        recursive: true,
      })
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
}

async function runRemote(
  sandbox: ModalSdkSandbox,
  command: string[],
  signal: AbortSignal | undefined,
  label: string,
  maxOutputBytes: number
): Promise<void> {
  const process = await abortable(
    sandbox.exec(command, {
      stderr: "pipe",
      stdout: "pipe",
    }),
    signal
  )
  await abortable(process.stdin.close(), signal)
  const [stderr, exitCode] = await abortable(
    Promise.all([readBoundedText(process.stderr, { bytes: 0 }, maxOutputBytes), process.wait()] as const),
    signal
  )

  if (exitCode !== 0) {
    throw new Error(`Modal Sandbox ${label} failed with exit code ${exitCode}: ${stderr.trim()}`)
  }
}

async function resolveSource(request: SandboxAcquireRequest, configuredWorkspace?: string): Promise<string> {
  const workspaceDirectory = request.workspace?.directory ?? configuredWorkspace

  if (workspaceDirectory === undefined) {
    throw new TypeError("Modal Sandbox requires an active Workspace or configured workspace")
  }

  const workspace = await realpath(workspaceDirectory)
  const source = await realpath(path.resolve(workspace, ...request.root.split("/")))
  assertPathWithin(workspace, source, "Modal Sandbox root")

  if (!(await stat(source)).isDirectory()) {
    throw new TypeError("Modal Sandbox root must be a directory")
  }

  const cwd = await realpath(path.resolve(workspace, ...request.cwd.split("/")))
  assertPathWithin(source, cwd, "Modal Sandbox cwd")
  return source
}

function guestPath(root: string, cwd: string): string {
  const normalizedRoot = path.posix.normalize(root)
  const normalizedCwd = path.posix.normalize(cwd)
  const relative = path.posix.relative(normalizedRoot, normalizedCwd)

  if (path.posix.isAbsolute(relative) || relative === ".." || relative.startsWith("../")) {
    throw new TypeError("Modal Sandbox command cwd resolves outside its configured root")
  }

  return path.posix.join(GUEST_ROOT, relative)
}

function assertPathWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate)

  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new TypeError(`${label} resolves outside its configured boundary`)
  }
}

async function runLocal(command: string, args: readonly string[], maxOutputBytes: number): Promise<void> {
  try {
    await execFileAsync(command, [...args], {
      encoding: "utf8",
      maxBuffer: maxOutputBytes,
      windowsHide: true,
    })
  } catch (cause) {
    throw new Error(`Modal Sandbox local Workspace transfer failed while running ${command}`, { cause })
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) {
    return promise
  }

  signal.throwIfAborted()

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

function parseOptions(value: ModalSandboxOptions): Readonly<ParsedModalSandboxOptions> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Modal Sandbox options must be an object")
  }

  if (value.client !== undefined && value.config !== undefined) {
    throw new TypeError("Modal Sandbox accepts either client or config, not both")
  }

  if (typeof value.image !== "string" || value.image.length === 0) {
    throw new TypeError("Modal Sandbox image must be a non-empty string")
  }

  const appName = value.appName ?? DEFAULT_APP_NAME

  if (typeof appName !== "string" || appName.length === 0) {
    throw new TypeError("Modal Sandbox appName must be a non-empty string")
  }

  const maxOutputBytes = value.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError("Modal Sandbox maxOutputBytes must be a positive safe integer")
  }

  if (value.setup !== undefined && (typeof value.setup !== "string" || value.setup.length === 0)) {
    throw new TypeError("Modal Sandbox setup must be a non-empty string")
  }

  if (value.workspace !== undefined && (typeof value.workspace !== "string" || value.workspace.length === 0)) {
    throw new TypeError("Modal Sandbox workspace must be a non-empty string")
  }

  return Object.freeze({
    ...value,
    appName,
    maxOutputBytes,
  })
}
