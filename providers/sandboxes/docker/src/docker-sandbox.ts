import { execFile } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

import {
  AbstractSandboxProvider,
  defineSandboxProvider,
  SandboxCommand,
  spawnLocalProcess,
  type ProvisionedSandbox,
  type SandboxAcquireRequest,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxFileOptions,
  type SandboxProcess,
  type SandboxProvider,
  type SandboxRuntime,
} from "@aml-jsx/sdk"

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const DEFAULT_IMAGE = "wearesingular/aml-agent-sandbox:latest"
const KEEPALIVE_COMMAND = "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done"

/**
 * Image-first configuration for the local Docker CLI adapter.
 */
export interface DockerSandboxOptions {
  /**
   * Image reference passed to `docker run`.
   *
   * Defaults to `"wearesingular/aml-agent-sandbox:latest"`. Pin a version or
   * digest when reproducibility matters. The image must already contain every
   * command and Agent dependency used by the workflow.
   */
  readonly image?: string

  /**
   * Maximum combined output retained from a Docker CLI or Sandbox command.
   *
   * Defaults to `4 * 1024 * 1024` bytes and must be a positive safe integer.
   */
  readonly maxOutputBytes?: number

  /**
   * Shell source run once through `sh -lc` after the container starts and the
   * Workspace is mounted, before the lease is returned.
   *
   * Omitted by default. A non-zero exit rejects acquisition and removes the
   * disposable container.
   */
  readonly setup?: string

  /**
   * Docker user or `UID:GID` passed through `docker run --user`.
   *
   * Omit to use the image default. The value must be a non-empty,
   * already-trimmed string without null bytes.
   */
  readonly user?: string

  /**
   * Fallback host Workspace directory used when no active `<Workspace>` exists.
   *
   * Omitted by default and resolved when the factory is called. An active
   * Workspace materialization takes precedence and is mounted at `/workspace`.
   */
  readonly workspace?: string
}

interface ParsedDockerSandboxOptions {
  readonly image: string
  readonly maxOutputBytes: number
  readonly setup?: string
  readonly user?: string
  readonly workspace?: string
}

/** Provider-specific identity exposed through a Docker Sandbox lease. */
export interface DockerSandboxHandle {
  /** Opaque Docker container id returned by `docker run`. */
  readonly containerId: string

  /** Stable provider-handle discriminant. */
  readonly kind: "docker"
}

interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: Readonly<SandboxExecOptions & { maxOutputBytes: number }>
  ): Promise<Readonly<SandboxExecResult>>
  spawn?(
    command: string,
    args: readonly string[],
    options: Readonly<SandboxExecOptions>,
    killRemote: () => Promise<void>
  ): Promise<Readonly<SandboxProcess>>
}

/**
 * Starts a named image through the local Docker CLI.
 *
 * AML does not build the image or install its Agent dependencies.
 * Each acquisition creates a disposable `--rm` container, bind-mounts the
 * effective Workspace at `/workspace`, and removes the container on release.
 * Read-only access is enforced on that mount, not on the container filesystem.
 *
 * @param options Image, mount source, setup command, user, and output budget.
 */
export function dockerSandbox(options: DockerSandboxOptions = {}): Readonly<SandboxProvider<DockerSandboxHandle>> {
  return createDockerSandboxProvider(options, new NodeCommandRunner())
}

/**
 * Internal construction seam used by deterministic provider tests.
 */
export function createDockerSandboxProvider(
  options: DockerSandboxOptions,
  runner: CommandRunner
): Readonly<SandboxProvider<DockerSandboxHandle>> {
  return defineSandboxProvider(new DockerSandboxProvider(parseOptions(options), runner))
}

class DockerSandboxProvider
  extends AbstractSandboxProvider<"docker", DockerSandboxHandle, string>
  implements SandboxProvider<DockerSandboxHandle>
{
  readonly #options: Readonly<ParsedDockerSandboxOptions>
  readonly #runner: CommandRunner

  constructor(options: Readonly<ParsedDockerSandboxOptions>, runner: CommandRunner) {
    super("docker")
    this.#options = options
    this.#runner = runner
  }

  protected async provision(
    request: SandboxAcquireRequest
  ): Promise<Readonly<ProvisionedSandbox<DockerSandboxHandle, string>>> {
    const source = await this.#resolveSource(request)
    const containerName = `aml-${request.evaluationId.slice(0, 12)}-${randomUUID().slice(0, 8)}`
    const mount = `${source}:/workspace${request.access === "read-only" ? ":ro" : ""}`
    const user = this.#options.user
    const start = await this.#runner
      .run(
        "docker",
        [
          "run",
          "--detach",
          "--rm",
          "--name",
          containerName,
          ...(user === undefined ? [] : ["--user", user]),
          "--volume",
          mount,
          "--workdir",
          guestPath(request.root, request.cwd),
          "--entrypoint",
          "sh",
          this.#options.image,
          "-c",
          KEEPALIVE_COMMAND,
        ],
        {
          maxOutputBytes: this.#options.maxOutputBytes,
          signal: request.signal,
        }
      )
      .catch(async cause => {
        try {
          await this.#removeContainer(containerName)
        } catch (cleanupCause) {
          throw new AggregateError([cause, cleanupCause], "Docker Sandbox startup and cleanup failed")
        }
        throw cause
      })

    if (start.exitCode !== 0) {
      const detail = (start.stderr || start.stdout).trim()
      const cause = new Error(`Docker Sandbox failed to start image "${this.#options.image}": ${detail}`)
      try {
        await this.#removeContainer(containerName)
      } catch (cleanupCause) {
        throw new AggregateError([cause, cleanupCause], "Docker Sandbox startup and cleanup failed")
      }
      throw cause
    }

    const containerId = start.stdout.trim()

    if (containerId.length === 0) {
      const cause = new Error("Docker Sandbox started without returning a container id")
      try {
        await this.#removeContainer(containerName)
      } catch (cleanupCause) {
        throw new AggregateError([cause, cleanupCause], "Docker Sandbox startup and cleanup failed")
      }
      throw cause
    }

    return Object.freeze({
      handle: Object.freeze({
        containerId,
        kind: "docker" as const,
      }),
      id: containerId,
      resource: containerId,
    })
  }

  protected createRuntime(
    provisioned: Readonly<ProvisionedSandbox<DockerSandboxHandle, string>>,
    request: SandboxAcquireRequest
  ): Readonly<SandboxRuntime> {
    const containerId = provisioned.resource
    const runDocker = async (args: readonly string[], signal: AbortSignal) =>
      await this.#runner.run("docker", args, {
        maxOutputBytes: this.#options.maxOutputBytes,
        signal,
      })

    const inspectGuestPath = async (guestFilePath: string, signal: AbortSignal) => {
      const result = await runDocker(["exec", containerId, "stat", "--format=%f:%s", "--", guestFilePath], signal)

      if (result.exitCode !== 0) {
        return undefined
      }

      const [modeValue, sizeValue] = result.stdout.trim().split(":")
      const mode = Number.parseInt(modeValue ?? "", 16) & 0xf000
      const size = Number.parseInt(sizeValue ?? "", 10)

      if (!Number.isSafeInteger(size) || size < 0) {
        throw new TypeError("Docker Sandbox returned invalid file metadata")
      }

      const kind = mode === 0x8000 ? "file" : mode === 0x4000 ? "directory" : "unsupported"
      return Object.freeze({ kind, size })
    }

    const assertGuestPath = async (
      guestFilePath: string,
      signal: AbortSignal,
      existing: boolean,
      boundary: string
    ): Promise<void> => {
      const result = await runDocker(
        [
          "exec",
          containerId,
          "realpath",
          existing ? "--canonicalize-existing" : "--canonicalize-missing",
          "--",
          existing ? guestFilePath : path.posix.dirname(guestFilePath),
        ],
        signal
      )

      if (result.exitCode !== 0) {
        throw new Error(`Docker Sandbox could not resolve file path: ${result.stderr.trim()}`)
      }

      assertGuestPathWithin(boundary, result.stdout.trim())
    }

    const writeGuestFile = async (
      guestFilePath: string,
      content: Uint8Array,
      signal: AbortSignal,
      boundary = "/workspace"
    ): Promise<void> => {
      await assertGuestPath(guestFilePath, signal, false, boundary)
      const existing = await inspectGuestPath(guestFilePath, signal)

      if (existing !== undefined && existing.kind !== "file") {
        throw new TypeError("Docker Sandbox file destination must be a regular file")
      }

      const parent = path.posix.dirname(guestFilePath)
      const prepare = await runDocker(["exec", containerId, "mkdir", "-p", "--", parent], signal)

      if (prepare.exitCode !== 0) {
        throw new Error(`Docker Sandbox could not prepare file directory: ${prepare.stderr.trim()}`)
      }

      const hostDirectory = await mkdtemp(path.join(os.tmpdir(), "aml-docker-file-"))
      const hostFile = path.join(hostDirectory, "content")
      const guestTemporary = path.posix.join(parent, `.aml-file-${randomUUID()}.tmp`)

      try {
        await writeFile(hostFile, content, { signal })
        const upload = await runDocker(["cp", hostFile, `${containerId}:${guestTemporary}`], signal)

        if (upload.exitCode !== 0) {
          throw new Error(`Docker Sandbox file upload failed: ${upload.stderr.trim()}`)
        }

        const replace = await runDocker(["exec", containerId, "mv", "--", guestTemporary, guestFilePath], signal)

        if (replace.exitCode !== 0) {
          throw new Error(`Docker Sandbox file replacement failed: ${replace.stderr.trim()}`)
        }
      } finally {
        await rm(hostDirectory, { force: true, recursive: true })
        await runDocker(["exec", containerId, "rm", "-f", "--", guestTemporary], new AbortController().signal).catch(
          () => undefined
        )
      }
    }

    const runtime: SandboxRuntime = {
      access: request.access,
      createFileStaging: async (options = {}) => {
        const signal = options.signal ?? request.signal
        signal.throwIfAborted()
        const stagingRoot = `/tmp/aml-agent-${randomUUID()}`
        const prepare = await runDocker(["exec", containerId, "mkdir", "-p", "--", stagingRoot], signal)

        if (prepare.exitCode !== 0) {
          throw new Error(`Docker Sandbox could not prepare Agent staging: ${prepare.stderr.trim()}`)
        }

        let releasePromise: Promise<void> | undefined

        return Object.freeze({
          release: () =>
            (releasePromise ??= runDocker(
              ["exec", containerId, "rm", "-rf", "--", stagingRoot],
              new AbortController().signal
            ).then(result => {
              if (result.exitCode !== 0) {
                throw new Error(`Docker Sandbox Agent staging cleanup failed: ${result.stderr.trim()}`)
              }
            })),
          root: stagingRoot,
          writeFile: async (filePath: string, content: Uint8Array, writeOptions: Readonly<SandboxFileOptions> = {}) => {
            await writeGuestFile(
              path.posix.join(stagingRoot, filePath),
              content,
              writeOptions.signal ?? signal,
              stagingRoot
            )
          },
        })
      },
      cwd: request.cwd,
      exec: async (command, args = [], options = {}) => {
        const captured = SandboxCommand.from(request, command, args, options)
        const dockerArgs = ["exec", "--workdir", guestPath(request.root, captured.cwd)]

        for (const [key, value] of Object.entries(captured.env)) {
          dockerArgs.push("--env", `${key}=${value}`)
        }

        dockerArgs.push(containerId, captured.command, ...captured.args)

        try {
          return await this.#runner.run("docker", dockerArgs, {
            maxOutputBytes: this.#options.maxOutputBytes,
            signal: captured.signal,
            ...(captured.timeoutMs === undefined ? {} : { timeoutMs: captured.timeoutMs }),
          })
        } catch (cause) {
          // A timed-out or cancelled `docker exec` can leave its remote process
          // alive, so terminate the disposable Sandbox before propagating.
          await this.#removeContainer(containerId)
          throw cause
        }
      },
      readFile: async (filePath, options = {}) => {
        const signal = options.signal ?? request.signal
        const guestFilePath = guestPath(request.root, filePath)
        const metadata = await inspectGuestPath(guestFilePath, signal)

        if (metadata?.kind !== "file") {
          throw new TypeError("Docker Sandbox file path must identify a regular file")
        }

        await assertGuestPath(guestFilePath, signal, true, "/workspace")
        const hostDirectory = await mkdtemp(path.join(os.tmpdir(), "aml-docker-read-"))
        const hostFile = path.join(hostDirectory, "content")

        try {
          const download = await runDocker(["cp", `${containerId}:${guestFilePath}`, hostFile], signal)

          if (download.exitCode !== 0) {
            throw new Error(`Docker Sandbox file download failed: ${download.stderr.trim()}`)
          }

          return Uint8Array.from(await readFile(hostFile, { signal }))
        } finally {
          await rm(hostDirectory, { force: true, recursive: true })
        }
      },
      root: request.root,
      spawn: async (command, args = [], options = {}) => {
        const captured = SandboxCommand.from(request, command, args, options)
        const spawnCommand = this.#runner.spawn

        if (spawnCommand === undefined) {
          throw new Error("Docker Sandbox command runner does not support spawn()")
        }

        const marker = `/tmp/aml-process-${randomUUID()}.pid`
        const dockerArgs = ["exec", "--interactive", "--workdir", guestPath(request.root, captured.cwd)]

        for (const [key, value] of Object.entries(captured.env)) {
          dockerArgs.push("--env", `${key}=${value}`)
        }

        // The marker captures the remote process-group leader before exec
        // replaces the shell with the requested literal command.
        dockerArgs.push(
          containerId,
          "sh",
          "-c",
          `echo $$ > ${marker}; exec "$@"`,
          "aml-spawn",
          captured.command,
          ...captured.args
        )

        return await Reflect.apply(spawnCommand, this.#runner, [
          "docker",
          dockerArgs,
          {
            signal: captured.signal,
            ...(captured.timeoutMs === undefined ? {} : { timeoutMs: captured.timeoutMs }),
          },
          async () => {
            await this.#runner.run(
              "docker",
              [
                "exec",
                containerId,
                "sh",
                "-c",
                `if test -s ${marker}; then kill -KILL -- -$(cat ${marker}) 2>/dev/null || kill -KILL $(cat ${marker}) 2>/dev/null || true; rm -f ${marker}; fi`,
              ],
              { maxOutputBytes: this.#options.maxOutputBytes }
            )
          },
        ])
      },
      stat: async (filePath, options = {}) => {
        const signal = options.signal ?? request.signal
        const guestFilePath = guestPath(request.root, filePath)
        const metadata = await inspectGuestPath(guestFilePath, signal)

        if (metadata === undefined || metadata.kind === "unsupported") {
          throw new TypeError("Docker Sandbox file path must identify a regular file or directory")
        }

        await assertGuestPath(guestFilePath, signal, true, "/workspace")
        return Object.freeze({
          kind: metadata.kind,
          size: metadata.kind === "file" ? metadata.size : 0,
        })
      },
      writeFile: async (filePath, content, options = {}) => {
        if (request.access !== "read-write") {
          throw new Error("Docker Sandbox filesystem is read-only")
        }

        const signal = options.signal ?? request.signal
        await writeGuestFile(guestPath(request.root, filePath), content, signal)
      },
    }

    return Object.freeze(runtime)
  }

  protected override async initialize(
    _provisioned: Readonly<ProvisionedSandbox<DockerSandboxHandle, string>>,
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
      throw new Error(`Docker Sandbox setup failed with exit code ${setup.exitCode}: ${setup.stderr.trim()}`)
    }
  }

  protected async releaseResource(
    provisioned: Readonly<ProvisionedSandbox<DockerSandboxHandle, string>>
  ): Promise<void> {
    await this.#removeContainer(provisioned.resource)
  }

  async #resolveSource(request: SandboxAcquireRequest): Promise<string> {
    const workspaceDirectory = request.workspace?.directory ?? this.#options.workspace

    if (workspaceDirectory === undefined) {
      throw new TypeError("Docker Sandbox requires an active Workspace or configured workspace")
    }

    const workspace = await realpath(workspaceDirectory)
    const source = await realpath(path.resolve(workspace, ...request.root.split("/")))
    assertPathWithin(workspace, source, "Docker Sandbox root")

    if (!(await stat(source)).isDirectory()) {
      throw new TypeError("Docker Sandbox root must be a directory")
    }

    const cwd = await realpath(path.resolve(workspace, ...request.cwd.split("/")))
    assertPathWithin(source, cwd, "Docker Sandbox cwd")
    request.signal.throwIfAborted()
    return source
  }

  async #removeContainer(container: string): Promise<void> {
    const result = await this.#runner.run("docker", ["rm", "--force", container], {
      maxOutputBytes: this.#options.maxOutputBytes,
    })

    if (result.exitCode !== 0 && !result.stderr.includes("No such container")) {
      throw new Error(`Docker Sandbox cleanup failed: ${(result.stderr || result.stdout).trim()}`)
    }
  }
}

function assertGuestPathWithin(root: string, candidate: string): void {
  const relative = path.posix.relative(root, candidate)

  if (path.posix.isAbsolute(relative) || relative === ".." || relative.startsWith("../")) {
    throw new TypeError("Docker Sandbox file path resolves outside its root")
  }
}

class NodeCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: readonly string[],
    options: Readonly<SandboxExecOptions & { maxOutputBytes: number }>
  ): Promise<Readonly<SandboxExecResult>> {
    options.signal?.throwIfAborted()
    const timeout = validateTimeout(options.timeoutMs)

    return await new Promise<Readonly<SandboxExecResult>>((resolve, reject) => {
      execFile(
        command,
        [...args],
        {
          encoding: "utf8",
          maxBuffer: options.maxOutputBytes,
          signal: options.signal,
          timeout,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (options.signal?.aborted) {
            reject(options.signal.reason)
            return
          }

          const exitCode = error === null ? 0 : error.code

          if (typeof exitCode !== "number") {
            reject(new Error(`Docker command failed: ${error?.message ?? "unknown failure"}`, { cause: error }))
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
    })
  }

  async spawn(
    command: string,
    args: readonly string[],
    options: Readonly<SandboxExecOptions>,
    killRemote: () => Promise<void>
  ): Promise<Readonly<SandboxProcess>> {
    return await spawnLocalProcess(command, args, {
      beforeKill: killRemote,
      cwd: process.cwd(),
      signal: options.signal ?? new AbortController().signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
  }
}

function guestPath(root: string, logicalPath: string): string {
  const relative = path.posix.relative(root, logicalPath)

  if (path.posix.isAbsolute(relative) || relative === ".." || relative.startsWith("../")) {
    throw new TypeError("Docker Sandbox cwd cannot escape its root")
  }

  return relative.length === 0 ? "/workspace" : path.posix.join("/workspace", relative)
}

function parseOptions(value: DockerSandboxOptions): Readonly<ParsedDockerSandboxOptions> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Docker Sandbox options must be an object")
  }

  const image = normalizedString(value.image ?? DEFAULT_IMAGE, "Docker Sandbox image")
  const setup = optionalNormalizedString(value.setup, "Docker Sandbox setup")
  const user = optionalNormalizedString(value.user, "Docker Sandbox user")
  const workspace = optionalNormalizedString(value.workspace, "Docker Sandbox workspace")
  const maxOutputBytes = value.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError("Docker Sandbox maxOutputBytes must be a positive safe integer")
  }

  return Object.freeze({
    image,
    maxOutputBytes,
    ...(setup === undefined ? {} : { setup }),
    ...(user === undefined ? {} : { user }),
    ...(workspace === undefined ? {} : { workspace: path.resolve(workspace) }),
  })
}

function normalizedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty normalized string`)
  }

  return value
}

function optionalNormalizedString(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : normalizedString(value, label)
}

function assertPathWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate)

  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new TypeError(`${label} resolves outside its configured boundary`)
  }
}

function validateTimeout(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError("Docker Sandbox timeoutMs must be a positive timer-safe integer")
  }

  return value
}
