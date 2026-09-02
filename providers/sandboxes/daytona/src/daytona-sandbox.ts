import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { cp, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import {
  Daytona,
  DaytonaNotFoundError,
  type CreateSandboxFromImageParams,
  type CreateSandboxFromSnapshotParams,
  type DaytonaConfig,
  type Sandbox as DaytonaSdkSandbox,
} from "@daytona/sdk"
import {
  AbstractSandboxProvider,
  defineSandboxProvider,
  SandboxCommand,
  type ProvisionedSandbox,
  type SandboxAcquireRequest,
  type SandboxFileOptions,
  type SandboxProcess,
  type SandboxProcessExit,
  type SandboxProvider,
  type SandboxRuntime,
} from "@aml-jsx/sdk"

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const DEFAULT_IMAGE = "wearesingular/aml-agent-sandbox:latest"
// Daytona commands start in the Sandbox user's writable home. A relative root
// avoids assuming that the selected snapshot grants access to filesystem `/`.
const GUEST_ROOT = "workspace"
const execFileAsync = promisify(execFile)

/** Daytona SDK controls applied while creating the remote Sandbox. */
export interface DaytonaSandboxCreateOptions {
  /**
   * Receives provider-native image snapshot creation log chunks.
   *
   * Omitted by default and used only for image-based creation; snapshot-based
   * creation does not expose this callback in the Daytona SDK.
   */
  readonly onSnapshotCreateLogs?: (chunk: string) => void

  /**
   * Daytona creation timeout in seconds.
   *
   * Omit for the Daytona SDK default of 60 seconds. The provider-native value
   * `0` disables that timeout.
   */
  readonly timeout?: number
}

/** Options shared by image- and snapshot-backed Daytona Sandboxes. */
interface DaytonaSandboxSharedOptions {
  /**
   * Preconstructed Daytona client to use for every acquisition.
   *
   * Omitted by default and mutually exclusive with `config`.
   */
  readonly client?: Daytona

  /**
   * Daytona SDK configuration used to construct a client lazily.
   *
   * Omitted by default and mutually exclusive with `client`.
   */
  readonly config?: DaytonaConfig

  /** Provider-native creation timeout and image snapshot log callback. */
  readonly createOptions?: DaytonaSandboxCreateOptions

  /**
   * Maximum combined command output and Workspace transfer budget.
   *
   * Defaults to `4 * 1024 * 1024` bytes and must be a positive safe integer.
   */
  readonly maxOutputBytes?: number

  /**
   * Shell source run through `sh -lc` after Workspace hydration and before the
   * lease is returned. Omitted by default; a non-zero exit rejects acquisition.
   */
  readonly setup?: string

  /**
   * Fallback local Workspace directory when no active `<Workspace>` exists.
   *
   * Omitted by default. An active Workspace materialization takes precedence.
   */
  readonly workspace?: string
}

/**
 * Provider-native Daytona configuration plus AML lifecycle conveniences.
 *
 * The environment identity is selected at the factory root. `create` retains
 * Daytona's remaining image- or snapshot-specific creation parameters.
 */
export type DaytonaSandboxOptions = DaytonaSandboxSharedOptions &
  (
    | {
        /**
         * Additional Daytona image-creation fields.
         *
         * `image` must remain at the factory root and cannot appear here.
         */
        readonly create?: Omit<CreateSandboxFromImageParams, "image">

        /** Image or declarative Daytona image used to create the environment. */
        readonly image: CreateSandboxFromImageParams["image"]

        /** Snapshot creation is unavailable when an explicit image is selected. */
        readonly snapshot?: never
      }
    | {
        /**
         * Additional Daytona snapshot-creation fields.
         *
         * `snapshot` must remain at the factory root and cannot appear here.
         */
        readonly create?: Omit<CreateSandboxFromSnapshotParams, "snapshot">

        /** Image selection is unavailable on the snapshot branch. */
        readonly image?: never

        /** Existing Daytona snapshot used for the environment. */
        readonly snapshot?: CreateSandboxFromSnapshotParams["snapshot"]
      }
  )

interface ParsedDaytonaSandboxOptions extends DaytonaSandboxSharedOptions {
  readonly create?: Omit<CreateSandboxFromImageParams, "image"> | Omit<CreateSandboxFromSnapshotParams, "snapshot">
  readonly image?: CreateSandboxFromImageParams["image"]
  readonly maxOutputBytes: number
  readonly snapshot?: CreateSandboxFromSnapshotParams["snapshot"]
}

/** Provider-specific handle exposed through a Daytona Sandbox lease. */
export interface DaytonaSandboxHandle {
  /** Stable provider-handle discriminant. */
  readonly kind: "daytona"

  /** Live Daytona SDK Sandbox object for provider-native inspection or APIs. */
  readonly sandbox: DaytonaSdkSandbox
}

interface DaytonaSandboxResource {
  readonly client: Daytona
  released: boolean
  readonly sandbox: DaytonaSdkSandbox
  readonly source: string
}

/**
 * Creates disposable Daytona environments and transfers one Workspace into
 * `workspace` under Daytona's default working directory for each acquisition.
 *
 * Omitting both `image` and `snapshot` selects
 * `wearesingular/aml-agent-sandbox:latest`. Writable release reconciles the
 * remote Workspace back to its local materialization before destroying the
 * environment; read-only release skips reconciliation.
 *
 * @param options Environment identity, Daytona client configuration, and lifecycle controls.
 */
export function daytonaSandbox(options: DaytonaSandboxOptions = {}): Readonly<SandboxProvider<DaytonaSandboxHandle>> {
  return defineSandboxProvider(new DaytonaSandboxProvider(parseOptions(options)))
}

class DaytonaSandboxProvider
  extends AbstractSandboxProvider<"daytona", DaytonaSandboxHandle, DaytonaSandboxResource>
  implements SandboxProvider<DaytonaSandboxHandle>
{
  #client: Daytona | undefined
  readonly #options: Readonly<ParsedDaytonaSandboxOptions>

  constructor(options: Readonly<ParsedDaytonaSandboxOptions>) {
    super("daytona")
    this.#options = options
    this.#client = options.client
  }

  protected async provision(
    request: SandboxAcquireRequest
  ): Promise<Readonly<ProvisionedSandbox<DaytonaSandboxHandle, DaytonaSandboxResource>>> {
    const client = this.#getClient()
    const source = await resolveSource(request, this.#options.workspace)
    const sandbox = await this.#createSandbox(client, request.signal)
    const resource: DaytonaSandboxResource = {
      client,
      released: false,
      sandbox,
      source,
    }

    try {
      await hydrateWorkspace(sandbox, source, this.#options.maxOutputBytes, request.signal)
      request.signal.throwIfAborted()
      return Object.freeze({
        handle: Object.freeze({
          kind: "daytona" as const,
          sandbox,
        }),
        id: sandbox.id,
        resource,
      })
    } catch (cause) {
      try {
        await this.#destroy(resource)
      } catch (cleanupError) {
        throw new AggregateError([cause, cleanupError], "Daytona Sandbox acquisition and cleanup failed")
      }

      throw cause
    }
  }

  protected createRuntime(
    provisioned: Readonly<ProvisionedSandbox<DaytonaSandboxHandle, DaytonaSandboxResource>>,
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
    _provisioned: Readonly<ProvisionedSandbox<DaytonaSandboxHandle, DaytonaSandboxResource>>,
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
      throw new Error(`Daytona Sandbox setup failed with exit code ${setup.exitCode}: ${setup.stdout.trim()}`)
    }
  }

  protected override async cleanupProvisioned(
    provisioned: Readonly<ProvisionedSandbox<DaytonaSandboxHandle, DaytonaSandboxResource>>
  ): Promise<void> {
    await this.#destroy(provisioned.resource)
  }

  protected async releaseResource(
    provisioned: Readonly<ProvisionedSandbox<DaytonaSandboxHandle, DaytonaSandboxResource>>,
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
          "Daytona Sandbox Workspace reconciliation and cleanup failed"
        )
      }

      throw cleanupError
    }

    if (reconciliationError !== undefined) {
      throw reconciliationError
    }
  }

  #getClient(): Daytona {
    this.#client ??= new Daytona(this.#options.config)
    return this.#client
  }

  async #createSandbox(client: Daytona, signal: AbortSignal): Promise<DaytonaSdkSandbox> {
    const creation = createDaytonaSandbox(client, this.#options)

    try {
      return await abortable(creation, signal)
    } catch (cause) {
      // Creation itself cannot currently accept an AbortSignal. If it finishes
      // after cancellation, reclaim the otherwise leaked remote Sandbox.
      void creation.then(
        async sandbox => await client.delete(sandbox),
        () => undefined
      )
      throw cause
    }
  }

  async #destroy(resource: DaytonaSandboxResource): Promise<void> {
    if (resource.released) {
      return
    }

    resource.released = true
    await resource.client.delete(resource.sandbox)
  }
}

function createRuntime(
  request: SandboxAcquireRequest,
  sandbox: DaytonaSdkSandbox,
  destroy: () => Promise<void>,
  maxOutputBytes: number
): Readonly<SandboxRuntime> {
  const getFileDetails = async (remotePath: string, signal: AbortSignal) => {
    try {
      return await abortable(sandbox.fs.getFileDetails(remotePath), signal)
    } catch (cause) {
      signal.throwIfAborted()

      if (cause instanceof DaytonaNotFoundError) {
        return undefined
      }

      throw cause
    }
  }

  const prepareDirectory = async (directory: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    const metadata = await getFileDetails(directory, signal)

    if (metadata !== undefined) {
      if (!metadata.isDir || isDaytonaSymlink(metadata.mode)) {
        throw new TypeError(`Daytona Sandbox file parent "${directory}" is not a directory`)
      }

      return
    }

    const parent = path.posix.dirname(directory)

    if (parent === directory) {
      throw new TypeError(`Daytona Sandbox file parent "${directory}" does not exist`)
    }

    await prepareDirectory(parent, signal)
    await abortable(sandbox.fs.createFolder(directory, "755"), signal)
  }

  const replaceFile = async (destination: string, content: Uint8Array, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    const parent = path.posix.dirname(destination)
    await prepareDirectory(parent, signal)
    const existing = await getFileDetails(destination, signal)

    if (existing !== undefined && (existing.isDir || !isDaytonaRegularFile(existing.mode))) {
      throw new TypeError("Daytona Sandbox file destination must be a regular file")
    }

    const temporary = path.posix.join(parent, `.aml-file-${randomUUID()}.tmp`)

    try {
      await abortable(sandbox.fs.uploadFile(Buffer.from(content), temporary), signal)
      await abortable(sandbox.fs.moveFiles(temporary, destination), signal)
    } finally {
      await sandbox.fs.deleteFile(temporary).catch(() => undefined)
    }
  }

  const runtime: SandboxRuntime = {
    access: request.access,
    async createFileStaging(options = {}) {
      const signal = options.signal ?? request.signal
      signal.throwIfAborted()
      const stagingRoot = `/tmp/aml-agent-${randomUUID()}`
      await prepareDirectory(stagingRoot, signal)
      let releasePromise: Promise<void> | undefined

      return Object.freeze({
        release: () => (releasePromise ??= sandbox.fs.deleteFile(stagingRoot, true)),
        root: stagingRoot,
        writeFile: async (filePath: string, content: Uint8Array, writeOptions: Readonly<SandboxFileOptions> = {}) => {
          await replaceFile(path.posix.join(stagingRoot, filePath), content, writeOptions.signal ?? signal)
        },
      })
    },
    cwd: request.cwd,
    async exec(command, args = [], options = {}) {
      if (request.access !== "read-write") {
        throw new Error(
          "Daytona Sandbox cannot execute under read-only access because its transferred Workspace is not mounted read-only"
        )
      }

      const captured = SandboxCommand.from(request, command, args, options)
      const cwd = guestPath(request.root, captured.cwd)
      const timeout = timeoutSeconds(captured.timeoutMs)
      const execution = sandbox.process.executeCommand(
        shellCommand(captured.command, captured.args),
        cwd,
        Object.keys(captured.env).length === 0 ? undefined : { ...captured.env },
        timeout
      )

      let result

      try {
        result = await abortable(execution, captured.signal)
      } catch (cause) {
        // Daytona's command API does not expose per-command cancellation. Tear
        // down the disposable environment so work cannot continue remotely.
        try {
          await destroy()
        } catch (cleanupError) {
          throw new AggregateError([cause, cleanupError], "Daytona Sandbox command and cleanup failed")
        }

        throw cause
      }

      if (Buffer.byteLength(result.result) > maxOutputBytes) {
        const cause = new RangeError(`Daytona Sandbox command output exceeded ${maxOutputBytes} bytes`)

        try {
          await destroy()
        } catch (cleanupError) {
          throw new AggregateError([cause, cleanupError], "Daytona Sandbox output limit and cleanup failed")
        }

        throw cause
      }

      return Object.freeze({
        exitCode: result.exitCode,
        stderr: "",
        stdout: result.result,
      })
    },
    async readFile(filePath, options = {}) {
      const signal = options.signal ?? request.signal
      const remotePath = guestPath(request.root, filePath)
      const info = await abortable(sandbox.fs.getFileDetails(remotePath), signal)

      if (info.isDir || !isDaytonaRegularFile(info.mode)) {
        throw new TypeError("Daytona Sandbox file path must identify a regular file")
      }

      return Uint8Array.from(await abortable(sandbox.fs.downloadFile(remotePath), signal))
    },
    root: request.root,
    async spawn(command, args = [], options = {}) {
      if (request.access !== "read-write") {
        throw new Error(
          "Daytona Sandbox cannot execute under read-only access because its transferred Workspace is not mounted read-only"
        )
      }

      const captured = SandboxCommand.from(request, command, args, options)
      const sessionId = `aml-${randomUUID()}`
      await abortable(sandbox.process.createSession(sessionId), captured.signal)
      const remoteCommand = [
        `cd ${quoteShell(guestPath(request.root, captured.cwd))}`,
        ...Object.entries(captured.env).map(([key, value]) => `export ${key}=${quoteShell(value)}`),
        `exec ${shellCommand(captured.command, captured.args)}`,
      ].join(" && ")

      try {
        const started = await abortable(
          sandbox.process.executeSessionCommand(
            sessionId,
            { command: remoteCommand, runAsync: true, suppressInputEcho: true },
            timeoutSeconds(captured.timeoutMs)
          ),
          captured.signal
        )
        return new DaytonaSandboxProcess(
          sandbox,
          sessionId,
          started.cmdId,
          captured.signal,
          captured.timeoutMs,
          maxOutputBytes
        )
      } catch (error) {
        await sandbox.process.deleteSession(sessionId).catch(() => undefined)
        throw error
      }
    },
    async stat(filePath, options = {}) {
      const signal = options.signal ?? request.signal
      const info = await abortable(sandbox.fs.getFileDetails(guestPath(request.root, filePath)), signal)

      if (isDaytonaSymlink(info.mode)) {
        throw new TypeError("Daytona Sandbox file path must not identify a symbolic link")
      }

      if (!info.isDir && !isDaytonaRegularFile(info.mode)) {
        throw new TypeError("Daytona Sandbox file path must identify a regular file or directory")
      }

      const modifiedAtMs = Date.parse(info.modifiedAt)
      const stat = {
        kind: info.isDir ? ("directory" as const) : ("file" as const),
        size: info.isDir ? 0 : info.size,
      }
      return Number.isFinite(modifiedAtMs) && modifiedAtMs >= 0
        ? Object.freeze({ ...stat, modifiedAtMs })
        : Object.freeze(stat)
    },
    async writeFile(filePath, content, options = {}) {
      if (request.access !== "read-write") {
        throw new Error("Daytona Sandbox filesystem is read-only")
      }

      await replaceFile(guestPath(request.root, filePath), content, options.signal ?? request.signal)
    },
  }

  return Object.freeze(runtime)
}

function isDaytonaSymlink(mode: string): boolean {
  return mode.startsWith("L") || mode.startsWith("l")
}

function isDaytonaRegularFile(mode: string): boolean {
  return mode.startsWith("-")
}

class DaytonaSandboxProcess implements SandboxProcess {
  readonly #commandId: string
  readonly #completion: Promise<Readonly<SandboxProcessExit>>
  #finished = false
  #killPromise: Promise<void> | undefined
  #killed = false
  readonly #sandbox: DaytonaSdkSandbox
  readonly #sessionId: string
  readonly id: string
  readonly stdin: WritableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>

  constructor(
    sandbox: DaytonaSdkSandbox,
    sessionId: string,
    commandId: string,
    signal: AbortSignal,
    timeoutMs: number | undefined,
    maxOutputBytes: number
  ) {
    this.#sandbox = sandbox
    this.#sessionId = sessionId
    this.#commandId = commandId
    this.id = `daytona:${sessionId}:${commandId}`
    this.stdin = new WritableStream({
      abort: async () => await this.kill(),
      // Daytona accepts text input but does not expose a true stdin half-close.
      // Closing the Web stream still prevents every later AML write.
      close: () => undefined,
      write: async data => {
        if (this.#finished) throw new Error("Daytona Sandbox process input is closed")
        await this.#sandbox.process.sendSessionCommandInput(
          this.#sessionId,
          this.#commandId,
          new TextDecoder().decode(data)
        )
      },
    })

    let stdoutController!: ReadableStreamDefaultController<Uint8Array>
    let stderrController!: ReadableStreamDefaultController<Uint8Array>
    let stdoutOpen = true
    let stderrOpen = true
    this.stdout = new ReadableStream({
      cancel: () => {
        stdoutOpen = false
      },
      start: controller => (stdoutController = controller),
    })
    this.stderr = new ReadableStream({
      cancel: () => {
        stderrOpen = false
      },
      start: controller => (stderrController = controller),
    })
    const encoder = new TextEncoder()
    let bufferedBytes = 0
    const enqueue = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      open: () => boolean,
      chunk: string
    ): void => {
      if (!open()) return
      const bytes = encoder.encode(chunk)
      bufferedBytes += bytes.byteLength
      if (bufferedBytes > maxOutputBytes) {
        const error = new RangeError(`Daytona Sandbox process output exceeded ${maxOutputBytes} bytes`)
        if (stdoutOpen) {
          stdoutOpen = false
          stdoutController.error(error)
        }
        if (stderrOpen) {
          stderrOpen = false
          stderrController.error(error)
        }
        void this.kill()
        return
      }
      controller.enqueue(bytes)
    }
    const finishStreams = (error?: unknown): void => {
      if (stdoutOpen) {
        stdoutOpen = false
        if (error === undefined) stdoutController.close()
        else stdoutController.error(error)
      }
      if (stderrOpen) {
        stderrOpen = false
        if (error === undefined) stderrController.close()
        else stderrController.error(error)
      }
    }

    // Daytona retains session logs, while these controllers queue chunks from
    // the moment the command id becomes available until a consumer reads them.
    this.#completion = sandbox.process
      .getSessionCommandLogs(
        sessionId,
        commandId,
        chunk => enqueue(stdoutController, () => stdoutOpen, chunk),
        chunk => enqueue(stderrController, () => stderrOpen, chunk)
      )
      .then(async () => {
        finishStreams()
        const command = await sandbox.process.getSessionCommand(sessionId, commandId)
        if (command.exitCode === undefined) {
          throw new Error("Daytona Sandbox process completed without an exit code")
        }
        return Object.freeze({ exitCode: command.exitCode })
      })
      .catch(error => {
        // Deleting an owned session is Daytona's process-tree kill. Its log or
        // status request can then race the deletion and report a missing
        // session; preserve that intentional termination as a stable result.
        if (this.#killed && isMissingDaytonaProcess(error)) {
          finishStreams()
          return Object.freeze({ exitCode: 137 })
        }

        finishStreams(error)
        throw error
      })
      .finally(() => {
        this.#finished = true
      })
    void this.#completion.catch(() => undefined)

    signal.addEventListener("abort", () => void this.kill(), { once: true })
    if (signal.aborted) void this.kill()
    if (timeoutMs !== undefined) {
      setTimeout(() => void this.kill(), timeoutMs).unref()
    }
  }

  async kill(): Promise<void> {
    if (this.#finished) return
    // Each AML spawn owns one Daytona session, so deleting it cannot terminate
    // a process from another evaluation lane.
    this.#killed = true
    this.#killPromise ??= this.#sandbox.process.deleteSession(this.#sessionId).catch(error => {
      if (!this.#finished && !isMissingDaytonaProcess(error)) throw error
    })
    await this.#killPromise
  }

  async wait(): Promise<Readonly<SandboxProcessExit>> {
    return await this.#completion
  }
}

function isMissingDaytonaProcess(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const code = Reflect.get(error, "code")
  const statusCode = Reflect.get(error, "statusCode")
  return code === "PROCESS_NOT_FOUND" || statusCode === 404
}

/**
 * Uploads an exact archive because file transfer is a provider lifecycle
 * concern, not part of the Agent-facing SandboxRuntime.
 */
async function hydrateWorkspace(
  sandbox: DaytonaSdkSandbox,
  source: string,
  maxOutputBytes: number,
  signal: AbortSignal
): Promise<void> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "aml-daytona-upload-"))
  const archive = path.join(temporaryDirectory, "workspace.tar")
  const remoteArchive = `/tmp/aml-workspace-${randomUUID()}.tar`

  try {
    await runLocal("tar", ["-C", source, "-cf", archive, "."], maxOutputBytes)
    await sandbox.fs.uploadFileStream(archive, remoteArchive, { signal })
    const result = await abortable(
      sandbox.process.executeCommand(
        `rm -rf -- ${quoteShell(GUEST_ROOT)} && mkdir -p -- ${quoteShell(GUEST_ROOT)} && tar -xf ${quoteShell(remoteArchive)} -C ${quoteShell(GUEST_ROOT)} && rm -f -- ${quoteShell(remoteArchive)}`
      ),
      signal
    )

    if (result.exitCode !== 0) {
      throw new Error(`Daytona Sandbox Workspace hydration failed: ${result.result.trim()}`)
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
}

/**
 * Downloads the complete remote tree and mirrors additions, modifications,
 * and deletions into the active local Workspace materialization.
 */
async function reconcileWorkspace(
  sandbox: DaytonaSdkSandbox,
  destination: string,
  maxOutputBytes: number
): Promise<void> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "aml-daytona-download-"))
  const archive = path.join(temporaryDirectory, "workspace.tar")
  const extracted = path.join(temporaryDirectory, "workspace")
  const remoteArchive = `/tmp/aml-workspace-${randomUUID()}.tar`

  try {
    const result = await sandbox.process.executeCommand(
      `tar -C ${quoteShell(GUEST_ROOT)} -cf ${quoteShell(remoteArchive)} .`
    )

    if (result.exitCode !== 0) {
      throw new Error(`Daytona Sandbox Workspace reconciliation failed: ${result.result.trim()}`)
    }

    await sandbox.fs.downloadFile(remoteArchive, archive)
    await sandbox.fs.deleteFile(remoteArchive)
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

async function resolveSource(request: SandboxAcquireRequest, configuredWorkspace?: string): Promise<string> {
  const workspaceDirectory = request.workspace?.directory ?? configuredWorkspace

  if (workspaceDirectory === undefined) {
    throw new TypeError("Daytona Sandbox requires an active Workspace or configured workspace")
  }

  const workspace = await realpath(workspaceDirectory)
  const source = await realpath(path.resolve(workspace, ...request.root.split("/")))
  assertPathWithin(workspace, source, "Daytona Sandbox root")

  if (!(await stat(source)).isDirectory()) {
    throw new TypeError("Daytona Sandbox root must be a directory")
  }

  const cwd = await realpath(path.resolve(workspace, ...request.cwd.split("/")))
  assertPathWithin(source, cwd, "Daytona Sandbox cwd")
  return source
}

function createDaytonaSandbox(
  client: Daytona,
  options: Readonly<ParsedDaytonaSandboxOptions>
): Promise<DaytonaSdkSandbox> {
  if (options.image !== undefined) {
    const params = {
      ...options.create,
      image: options.image,
    } as CreateSandboxFromImageParams

    return client.create(params, options.createOptions)
  }

  const snapshotOptions =
    options.createOptions?.timeout === undefined
      ? undefined
      : {
          timeout: options.createOptions.timeout,
        }

  const params =
    options.create === undefined && options.snapshot === undefined
      ? undefined
      : ({
          ...options.create,
          ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
        } as CreateSandboxFromSnapshotParams)

  return client.create(params as CreateSandboxFromSnapshotParams | undefined, snapshotOptions)
}

function guestPath(root: string, cwd: string): string {
  const normalizedRoot = path.posix.normalize(root)
  const normalizedCwd = path.posix.normalize(cwd)
  const relative = path.posix.relative(normalizedRoot, normalizedCwd)

  if (path.posix.isAbsolute(relative) || relative === ".." || relative.startsWith("../")) {
    throw new TypeError("Daytona Sandbox command cwd resolves outside its configured root")
  }

  return path.posix.join(GUEST_ROOT, relative)
}

function shellCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteShell).join(" ")
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function timeoutSeconds(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) {
    return undefined
  }

  return Math.max(1, Math.ceil(timeoutMs / 1000))
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
    throw new Error(`Daytona Sandbox local Workspace transfer failed while running ${command}`, { cause })
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

function parseOptions(value: DaytonaSandboxOptions): Readonly<ParsedDaytonaSandboxOptions> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Daytona Sandbox options must be an object")
  }

  if (value.client !== undefined && value.config !== undefined) {
    throw new TypeError("Daytona Sandbox accepts either client or config, not both")
  }

  const create = value.create as Record<string, unknown> | undefined

  if (create !== undefined && ("image" in create || "snapshot" in create)) {
    throw new TypeError("Daytona Sandbox image and snapshot are root options, not create options")
  }

  if (value.image !== undefined && value.snapshot !== undefined) {
    throw new TypeError("Daytona Sandbox accepts either image or snapshot, not both")
  }

  const { image: configuredImage, snapshot, ...sharedOptions } = value
  const maxOutputBytes = value.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const image = configuredImage ?? (snapshot === undefined ? DEFAULT_IMAGE : undefined)

  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError("Daytona Sandbox maxOutputBytes must be a positive safe integer")
  }

  if (value.setup !== undefined && (typeof value.setup !== "string" || value.setup.length === 0)) {
    throw new TypeError("Daytona Sandbox setup must be a non-empty string")
  }

  if (value.workspace !== undefined && (typeof value.workspace !== "string" || value.workspace.length === 0)) {
    throw new TypeError("Daytona Sandbox workspace must be a non-empty string")
  }

  return Object.freeze({
    ...sharedOptions,
    ...(image === undefined ? {} : { image }),
    maxOutputBytes,
    ...(snapshot === undefined ? {} : { snapshot }),
  })
}
