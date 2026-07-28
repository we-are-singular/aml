import { randomUUID } from "node:crypto"
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import type Dockerode from "dockerode"

import {
  defineSandboxProvider,
  type SandboxAcquireRequest,
  type SandboxLease,
  type SandboxProvider,
} from "@aml-jsx/sdk"

import type { DockerCommandResult, DockerExecOptions, DockerSandboxHandle } from "./docker-sandbox-handle.js"
import { followDockerBuildProgress } from "./docker-build-progress.js"
import { captureDockerCommandOutput } from "./docker-command-output.js"
import {
  parseDockerSandboxOptions,
  type DockerSandboxOptions,
  type ParsedDockerSandboxOptions,
} from "./docker-sandbox-options.js"

export type { DockerSandboxOptions } from "./docker-sandbox-options.js"

interface ResolvedBuildContext {
  readonly context: string
  readonly dockerfile: string
}

interface ResolvedSource {
  readonly source: string
}

interface HostNamespaceProbe {
  readonly directory: string
  readonly token: string
}

const AMBIGUOUS_CREATE_RECONCILIATION_DELAYS = [0, 50, 100, 250, 500, 1_000] as const

/**
 * Creates a lazy Docker provider with an optional standalone host fallback.
 *
 * Construction performs no Docker or filesystem I/O. Each outermost
 * `<Sandbox>` uses its active Workspace first, creates one hardened container,
 * and leaves release ownership with AML.
 */
export function dockerSandbox(options: DockerSandboxOptions): Readonly<SandboxProvider<DockerSandboxHandle>> {
  return defineSandboxProvider(new DockerSandboxProvider(parseDockerSandboxOptions(options)))
}

/**
 * Translates AML Sandbox policy into Docker Engine resources.
 *
 * Dockerode owns protocol transport, Engine errors, exec streams, and builds.
 * This adapter owns only the AML policy mapping and lease lifecycle.
 */
class DockerSandboxProvider implements SandboxProvider<DockerSandboxHandle> {
  readonly #options: Readonly<ParsedDockerSandboxOptions>
  #builtImage: string | undefined
  readonly name = "docker"

  /**
   * Captures validated configuration without touching Docker or the filesystem.
   */
  constructor(options: Readonly<ParsedDockerSandboxOptions>) {
    this.#options = options
  }

  /**
   * Creates and starts one hardened container for an AML Sandbox lease.
   */
  async acquire(request: SandboxAcquireRequest): Promise<SandboxLease<DockerSandboxHandle>> {
    request.signal.throwIfAborted()
    const resolvedSource = await this.#resolveSource(request)
    const image = await this.#resolveImage(request.signal)
    let namespaceProbe: Readonly<HostNamespaceProbe>

    try {
      namespaceProbe = await createHostNamespaceProbe(resolvedSource.source)
    } catch (cause) {
      throw new Error("Docker Sandbox selected source must be writable for namespace verification", { cause })
    }

    if (request.signal.aborted) {
      try {
        await removeHostNamespaceProbe(namespaceProbe)
      } catch (cleanupError) {
        throw new AggregateError(
          [request.signal.reason, cleanupError],
          "Docker Sandbox cancellation and namespace-probe cleanup both failed"
        )
      }

      throw request.signal.reason
    }

    // The UUID-backed name lets a definitive Engine failure compensate by
    // name even when Dockerode never returned a container object.
    const containerName = `aml-${request.evaluationId.slice(0, 12)}-${randomUUID().slice(0, 8)}`
    let container: Dockerode.Container

    try {
      // Do not abort the create transport. An aborted HTTP request does not
      // prove the daemon abandoned creation, which can orphan a late container.
      container = await this.#options.client.createContainer({
        AttachStderr: false,
        AttachStdin: false,
        AttachStdout: false,
        Cmd: ["-c", "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done"],
        Entrypoint: ["sh"],
        HostConfig: {
          AutoRemove: true,
          CapDrop: ["ALL"],
          Init: true,
          Memory: this.#options.memoryBytes,
          Mounts: [
            {
              ReadOnly: request.access === "read-only",
              Source: resolvedSource.source,
              Target: "/workspace",
              Type: "bind",
            },
            {
              ReadOnly: true,
              Source: namespaceProbe.directory,
              Target: "/run/aml-host-namespace",
              Type: "bind",
            },
          ],
          NanoCpus: this.#options.nanoCpus,
          NetworkMode: "none",
          PidsLimit: this.#options.pidsLimit,
          ReadonlyRootfs: true,
          SecurityOpt: ["no-new-privileges"],
          Tmpfs: {
            "/tmp": `rw,noexec,nosuid,nodev,size=${this.#options.tmpfsBytes}`,
          },
        },
        Image: image,
        Labels: {
          "dev.agent-markup-language.sandbox": "true",
        },
        NetworkDisabled: true,
        OpenStdin: false,
        Tty: false,
        User: this.#options.user,
        WorkingDir: toContainerPath(request.root, request.cwd),
        name: containerName,
      })
    } catch (error) {
      return await this.#throwAfterAcquisitionCleanup(
        undefined,
        containerName,
        namespaceProbe,
        request.signal.aborted
          ? request.signal.reason
          : new Error("Docker Sandbox creation failed", {
              cause: error,
            }),
        !hasDockerStatusCode(error)
      )
    }

    if (request.signal.aborted) {
      return await this.#throwAfterAcquisitionCleanup(
        container,
        containerName,
        namespaceProbe,
        request.signal.reason,
        false
      )
    }

    try {
      await container.start({ abortSignal: request.signal })
      request.signal.throwIfAborted()
      await this.#verifyHostNamespace(container, request, namespaceProbe.token)
      await removeHostNamespaceProbe(namespaceProbe)
    } catch (error) {
      return await this.#throwAfterAcquisitionCleanup(
        container,
        containerName,
        namespaceProbe,
        request.signal.aborted
          ? request.signal.reason
          : new Error("Docker Sandbox startup or namespace verification failed", {
              cause: error,
            }),
        false
      )
    }

    const handle = this.#createHandle(container, request)

    return Object.freeze({
      handle,
      id: container.id,
      release: async () => {
        await this.#removeContainer(container)
      },
    })
  }

  /**
   * Proves the daemon resolves bind sources in AML's filesystem namespace.
   */
  async #verifyHostNamespace(
    container: Dockerode.Container,
    request: SandboxAcquireRequest,
    expectedToken: string
  ): Promise<void> {
    const result = await this.#executeInContainer(
      container,
      request,
      ["sh", "-c", 'IFS= read -r value < /run/aml-host-namespace/identity; printf %s "$value"'],
      {
        cwd: request.cwd,
        signal: request.signal,
      },
      128
    )

    if (result.exitCode !== 0 || result.stderr !== "" || result.stdout !== expectedToken) {
      throw new Error("Docker daemon does not share AML's workspace filesystem namespace")
    }
  }

  /**
   * Produces the opaque capability consumed by compatible Agent adapters.
   */
  #createHandle(container: Dockerode.Container, request: SandboxAcquireRequest): Readonly<DockerSandboxHandle> {
    return Object.freeze({
      access: request.access,
      containerId: container.id,
      exec: async (command: readonly string[], options: DockerExecOptions) =>
        await this.#executeInContainer(container, request, command, options),
      kind: "docker",
      root: request.root,
    })
  }

  /**
   * Runs one argument-array command through Docker's exec API.
   */
  async #executeInContainer(
    container: Dockerode.Container,
    request: SandboxAcquireRequest,
    command: readonly string[],
    options: DockerExecOptions,
    maxOutputBytes = this.#options.maxOutputBytes
  ): Promise<DockerCommandResult> {
    const capturedCommand = captureContainerCommand(command)

    if (typeof options !== "object" || options === null) {
      throw new TypeError("Docker Sandbox command options with an effective cwd are required")
    }

    const signal = options.signal ?? request.signal
    const workingDirectory = toContainerPath(request.root, options.cwd)
    signal.throwIfAborted()

    try {
      const execution = await container.exec({
        AttachStderr: true,
        AttachStdout: true,
        Cmd: [...capturedCommand],
        Tty: false,
        WorkingDir: workingDirectory,
        abortSignal: signal,
      })
      const stream = await execution.start({
        Detach: false,
        Tty: false,
        abortSignal: signal,
      })
      const output = await captureDockerCommandOutput(this.#options.client, stream, maxOutputBytes)
      const inspection = await execution.inspect({
        abortSignal: signal,
      })
      signal.throwIfAborted()

      if (inspection.ExitCode === null) {
        throw new Error("Docker Sandbox command ended without an exit code")
      }

      return Object.freeze({
        exitCode: inspection.ExitCode,
        stderr: output.stderr,
        stdout: output.stdout,
      })
    } catch (cause) {
      signal.throwIfAborted()
      throw new Error("Docker Sandbox command failed", { cause })
    }
  }

  /**
   * Returns a configured image or builds the Dockerfile once after success.
   */
  async #resolveImage(signal: AbortSignal): Promise<string> {
    if (this.#options.image !== undefined) {
      return this.#options.image
    }

    if (this.#builtImage !== undefined) {
      return this.#builtImage
    }

    const build = await this.#resolveBuildContext(signal)
    let stream: NodeJS.ReadableStream

    try {
      stream = await this.#options.client.buildImage(
        {
          context: build.context,
          src: ["."],
        },
        {
          abortSignal: signal,
          dockerfile: build.dockerfile,
          forcerm: true,
          labels: {
            "dev.agent-markup-language.sandbox": "true",
          },
          networkmode: "none",
          rm: true,
          t: this.#options.buildTag,
          version: "2",
        }
      )
      await followDockerBuildProgress(this.#options.client, stream)
      signal.throwIfAborted()
    } catch (cause) {
      signal.throwIfAborted()
      throw new Error("Docker Sandbox image build failed", {
        cause,
      })
    }

    // Cache only a completed build. A failed or cancelled build remains
    // retryable on the next acquisition.
    this.#builtImage ??= this.#options.buildTag
    return this.#builtImage
  }

  /**
   * Resolves the Dockerfile relative to its real build context.
   */
  async #resolveBuildContext(signal: AbortSignal): Promise<ResolvedBuildContext> {
    const context = await realpath(this.#options.buildContext!)
    signal.throwIfAborted()
    const contextStat = await stat(context)

    if (!contextStat.isDirectory()) {
      throw new TypeError("Docker Sandbox build context must be a directory")
    }

    const dockerfile = await realpath(this.#options.dockerfile!)
    signal.throwIfAborted()
    assertPathWithin(context, dockerfile, "Dockerfile")
    const dockerfileStat = await stat(dockerfile)

    if (!dockerfileStat.isFile()) {
      throw new TypeError("Dockerfile path must be a file")
    }

    return Object.freeze({
      context,
      // The Engine receives a tar archive, so Dockerfile paths are relative
      // to that archive even when application configuration is absolute.
      dockerfile: path.relative(context, dockerfile).split(path.sep).join("/"),
    })
  }

  /**
   * Resolves the selected bind mount and cwd through host symlinks.
   */
  async #resolveSource(request: SandboxAcquireRequest): Promise<ResolvedSource> {
    // An active durable materialization always wins over the provider's
    // standalone fallback; silently mounting different files would violate
    // the Workspace-to-Sandbox attachment contract.
    const workspaceDirectory = request.workspace?.directory ?? this.#options.workspace

    if (workspaceDirectory === undefined) {
      throw new TypeError("Docker Sandbox requires an active Workspace or configured workspace")
    }

    const workspace = await realpath(workspaceDirectory)
    request.signal.throwIfAborted()
    const source = await realpath(path.resolve(workspace, request.root))
    request.signal.throwIfAborted()
    assertPathWithin(workspace, source, "Sandbox root")
    const sourceStat = await stat(source)

    if (!sourceStat.isDirectory()) {
      throw new TypeError("Docker Sandbox root must be a directory")
    }

    const cwd = await realpath(path.resolve(workspace, request.cwd))
    request.signal.throwIfAborted()
    assertPathWithin(source, cwd, "Sandbox cwd")
    const cwdStat = await stat(cwd)

    if (!cwdStat.isDirectory()) {
      throw new TypeError("Docker Sandbox cwd must be a directory")
    }

    return Object.freeze({ source })
  }

  /**
   * Removes a container and treats an already-absent resource as released.
   */
  async #removeContainer(container: Dockerode.Container): Promise<void> {
    try {
      await container.remove({ force: true })
    } catch (cause) {
      if (isDockerNotFound(cause)) {
        return
      }

      throw new Error(`Docker Sandbox "${container.id}" cleanup failed`, { cause })
    }
  }

  /**
   * Preserves the acquisition failure and every failed compensation step.
   */
  async #throwAfterAcquisitionCleanup(
    container: Dockerode.Container | undefined,
    containerName: string,
    namespaceProbe: HostNamespaceProbe,
    primaryError: unknown,
    reconcileByName: boolean
  ): Promise<never> {
    const cleanupErrors: unknown[] = []

    try {
      if (container !== undefined) {
        await this.#removeContainer(container)
      } else if (reconcileByName) {
        await this.#reconcileContainerName(containerName)
      } else {
        await this.#removeContainer(this.#options.client.getContainer(containerName))
      }
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }

    try {
      await removeHostNamespaceProbe(namespaceProbe)
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError([primaryError, ...cleanupErrors], "Docker Sandbox acquisition and cleanup both failed")
    }

    throw primaryError
  }

  /**
   * Rechecks an ambiguous create failure before declaring its name absent.
   */
  async #reconcileContainerName(containerName: string): Promise<void> {
    const container = this.#options.client.getContainer(containerName)

    // A transport error cannot tell whether Engine committed the request. The
    // bounded backoff catches late local registration, but absence remains
    // uncertain and is surfaced as cleanup failure rather than declared safe.
    for (const waitMilliseconds of AMBIGUOUS_CREATE_RECONCILIATION_DELAYS) {
      if (waitMilliseconds > 0) {
        await delay(waitMilliseconds)
      }

      try {
        await container.inspect()
        await this.#removeContainer(container)
        return
      } catch (error) {
        if (!isDockerNotFound(error)) {
          throw new Error(`Docker Sandbox "${containerName}" reconciliation failed`, { cause: error })
        }
      }
    }

    throw new Error(
      `Docker Sandbox "${containerName}" remained absent during bounded reconciliation; cleanup cannot be proven`
    )
  }
}

/**
 * Creates an ephemeral identity mount beneath the exact selected source.
 */
async function createHostNamespaceProbe(source: string): Promise<Readonly<HostNamespaceProbe>> {
  const token = randomUUID()
  const directory = await mkdtemp(path.join(source, ".aml-docker-namespace-"))

  try {
    // The container runs as a non-root UID, so it needs traverse/read access
    // without receiving write authority over this host-owned probe.
    await chmod(directory, 0o755)
    await writeFile(path.join(directory, "identity"), token, {
      mode: 0o644,
    })
  } catch (primaryError) {
    try {
      await rm(directory, { force: true, recursive: true })
    } catch (cleanupError) {
      throw new AggregateError([primaryError, cleanupError], "Docker namespace probe setup and cleanup both failed")
    }

    throw primaryError
  }

  return Object.freeze({ directory, token })
}

/**
 * Removes the host-side identity mount after startup or failed acquisition.
 */
async function removeHostNamespaceProbe(probe: HostNamespaceProbe): Promise<void> {
  await rm(probe.directory, { force: true, recursive: true })
}

/**
 * Copies and validates model-controlled command arguments.
 */
function captureContainerCommand(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Docker Sandbox command must contain an executable")
  }

  const command = value.map((argument, index) => {
    if (typeof argument !== "string" || argument.includes("\0") || (index === 0 && argument.length === 0)) {
      throw new TypeError("Docker Sandbox command contains an invalid argument")
    }

    return argument
  })

  return Object.freeze(command)
}

/**
 * Maps one AML working directory into the fixed container mount.
 */
function toContainerPath(root: string, cwd: unknown): string {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new TypeError("Docker Sandbox cwd must be a non-empty string")
  }

  const relative = path.posix.relative(root, cwd)

  if (path.posix.isAbsolute(relative) || relative === ".." || relative.startsWith("../")) {
    throw new TypeError("Docker Sandbox cwd cannot escape its root")
  }

  return path.posix.join("/workspace", relative)
}

/**
 * Enforces real host containment after symlink resolution.
 */
function assertPathWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate)

  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new TypeError(`${label} resolves outside its configured boundary`)
  }
}

/**
 * Recognizes Docker Engine's idempotent already-absent cleanup result.
 */
function isDockerNotFound(value: unknown): boolean {
  return typeof value === "object" && value !== null && "statusCode" in value && value.statusCode === 404
}

/**
 * Distinguishes Engine responses from transport failures with unknown outcome.
 */
function hasDockerStatusCode(value: unknown): boolean {
  return typeof value === "object" && value !== null && "statusCode" in value && typeof value.statusCode === "number"
}
