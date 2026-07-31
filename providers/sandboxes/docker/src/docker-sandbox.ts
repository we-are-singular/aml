import { execFile, spawn } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { Readable } from "node:stream"

import {
  AbstractSandboxProvider,
  defineSandboxProvider,
  SandboxCommand,
  type ProvisionedSandbox,
  type SandboxAcquireRequest,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxProcess,
  type SandboxProcessExit,
  type SandboxProvider,
  type SandboxRuntime,
} from "@aml-jsx/sdk"

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const KEEPALIVE_COMMAND = "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done"

/**
 * Image-first configuration for the local Docker CLI adapter.
 */
export interface DockerSandboxOptions {
  readonly image: string
  readonly maxOutputBytes?: number
  readonly setup?: string
  readonly workspace?: string
}

interface ParsedDockerSandboxOptions {
  readonly image: string
  readonly maxOutputBytes: number
  readonly setup?: string
  readonly workspace?: string
}

export interface DockerSandboxHandle {
  readonly containerId: string
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
 */
export function dockerSandbox(options: DockerSandboxOptions): Readonly<SandboxProvider<DockerSandboxHandle>> {
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
    const start = await this.#runner
      .run(
        "docker",
        [
          "run",
          "--detach",
          "--rm",
          "--name",
          containerName,
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
    const runtime: SandboxRuntime = {
      access: request.access,
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
    options.signal?.throwIfAborted()
    const child = spawn(command, [...args], {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    return new DockerSandboxProcess(child, options, killRemote)
  }
}

class DockerSandboxProcess implements SandboxProcess {
  readonly #child: ReturnType<typeof spawn>
  readonly #completion: Promise<Readonly<SandboxProcessExit>>
  readonly #hostProcessGroupId: number
  readonly #killRemote: () => Promise<void>
  #closePromise: Promise<void> | undefined
  #finished = false
  #killPromise: Promise<void> | undefined
  readonly id: string
  readonly stderr: ReadableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>

  constructor(child: ReturnType<typeof spawn>, options: Readonly<SandboxExecOptions>, killRemote: () => Promise<void>) {
    if (child.pid === undefined || child.stdout === null || child.stderr === null || child.stdin === null) {
      child.kill()
      throw new Error("Docker Sandbox failed to create process pipes")
    }

    this.#child = child
    this.#hostProcessGroupId = child.pid
    this.#killRemote = killRemote
    this.id = `docker-exec:${child.pid}`
    this.stdout = bufferedNodeStream(child.stdout)
    this.stderr = bufferedNodeStream(child.stderr)
    this.#completion = new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", code => {
        this.#finished = true
        if (options.signal?.aborted) {
          reject(options.signal.reason)
        } else if (code === null) {
          reject(new Error("Docker Sandbox process exited without an exit code"))
        } else {
          resolve(Object.freeze({ exitCode: code }))
        }
      })
    })
    // A caller may use only the streams and kill handle. Keep the cached wait
    // rejection observable without letting an optional wait() become unhandled.
    void this.#completion.catch(() => undefined)

    options.signal?.addEventListener("abort", () => void this.kill(), { once: true })
    if (options.signal?.aborted) void this.kill()
    if (options.timeoutMs !== undefined) {
      setTimeout(() => void this.kill(), options.timeoutMs).unref()
    }
  }

  async closeInput(): Promise<void> {
    if (this.#finished) return
    this.#closePromise ??= new Promise(resolve => this.#child.stdin?.end(resolve))
    await this.#closePromise
  }

  async kill(): Promise<void> {
    if (this.#finished) return
    this.#killPromise ??= (async () => {
      await this.#killRemote()
      try {
        if (process.platform === "win32") this.#child.kill("SIGKILL")
        else process.kill(-this.#hostProcessGroupId, "SIGKILL")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    })()
    await this.#killPromise
  }

  async wait(): Promise<Readonly<SandboxProcessExit>> {
    return await this.#completion
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.#finished || this.#child.stdin === null || this.#child.stdin.destroyed) {
      throw new Error("Docker Sandbox process input is closed")
    }
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin?.write(data, (error: Error | null | undefined) =>
        error === null || error === undefined ? resolve() : reject(error)
      )
    })
  }
}

function bufferedNodeStream(stream: Readable): ReadableStream<Uint8Array> {
  let controller: ReadableStreamDefaultController<Uint8Array>
  const readable = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
    cancel() {
      stream.destroy()
    },
    pull() {
      stream.resume()
    },
  })
  stream.on("data", chunk => {
    controller.enqueue(new Uint8Array(Buffer.from(chunk)))
    if ((controller.desiredSize ?? 0) <= 0) stream.pause()
  })
  stream.once("end", () => controller.close())
  stream.once("error", error => controller.error(error))
  return readable
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

  const image = normalizedString(value.image, "Docker Sandbox image")
  const setup = optionalNormalizedString(value.setup, "Docker Sandbox setup")
  const workspace = optionalNormalizedString(value.workspace, "Docker Sandbox workspace")
  const maxOutputBytes = value.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError("Docker Sandbox maxOutputBytes must be a positive safe integer")
  }

  return Object.freeze({
    image,
    maxOutputBytes,
    ...(setup === undefined ? {} : { setup }),
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
