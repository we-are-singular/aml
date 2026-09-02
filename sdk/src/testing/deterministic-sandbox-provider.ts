import path from "node:path"

import type { SandboxAcquireRequest, SandboxLease, SandboxProvider } from "../components/sandbox/sandbox-provider.js"
import type {
  SandboxExecOptions,
  SandboxExecResult,
  SandboxProcess,
  SandboxRuntime,
} from "../components/sandbox/sandbox-runtime.js"

/**
 * Default opaque handle exposed by the deterministic Sandbox fixture.
 */
export interface DeterministicSandboxHandle {
  /** Zero-based acquisition order for this fixture instance. */
  readonly acquisition: number

  /** Stable default-handle discriminant. */
  readonly kind: "deterministic-sandbox"

  /** Exact acquisition request recorded by the provider. */
  readonly request: SandboxAcquireRequest
}

/** Lease identity passed to deterministic Sandbox release hooks. */
interface DeterministicSandboxLeaseIdentity<Handle> {
  /** Handle returned by the configured creation strategy. */
  readonly handle: Handle

  /** Deterministic lease id in `<provider-name>-<one-based-index>` form. */
  readonly id: string
}

/**
 * Configuration hooks for deterministic acquisition and release behavior.
 */
export interface DeterministicSandboxProviderOptions<Handle> {
  /**
   * Creates the provider-specific handle for an acquisition.
   *
   * Defaults to a {@link DeterministicSandboxHandle}. `acquisition` is the
   * zero-based call index.
   */
  readonly createHandle?: (request: SandboxAcquireRequest, acquisition: number) => Handle | PromiseLike<Handle>

  /**
   * Implements deterministic buffered command execution.
   *
   * Defaults to exit code `0`, empty stderr, and stdout containing the command
   * and arguments joined by spaces.
   */
  readonly exec?: (
    command: string,
    args: readonly string[],
    request: SandboxAcquireRequest,
    options: Readonly<SandboxExecOptions>
  ) => SandboxExecResult | PromiseLike<SandboxExecResult>

  /**
   * Provider identifier used in lease ids.
   *
   * Defaults to `"deterministic-sandbox"` and must be non-empty and trimmed.
   */
  readonly name?: string

  /**
   * Hook invoked when a lease is released, after its id is recorded.
   *
   * Defaults to a no-op. `acquisition` is the zero-based acquisition index.
   */
  readonly release?: (
    lease: Readonly<DeterministicSandboxLeaseIdentity<Handle>>,
    acquisition: number
  ) => void | PromiseLike<void>

  /**
   * Implements deterministic streaming process execution.
   *
   * Defaults to an already-completed process whose stdout contains the command
   * and arguments, stderr is empty, and exit code is `0`.
   */
  readonly spawn?: (
    command: string,
    args: readonly string[],
    request: SandboxAcquireRequest,
    options: Readonly<SandboxExecOptions>
  ) => SandboxProcess | PromiseLike<SandboxProcess>
}

/**
 * Records Sandbox lifecycle calls without creating real infrastructure.
 */
export class DeterministicSandboxProvider<Handle = DeterministicSandboxHandle> implements SandboxProvider<Handle> {
  readonly #acquisitions: SandboxAcquireRequest[] = []
  readonly #createHandle: (request: SandboxAcquireRequest, acquisition: number) => Handle | PromiseLike<Handle>
  readonly #exec: NonNullable<DeterministicSandboxProviderOptions<Handle>["exec"]>
  readonly #release: (
    lease: Readonly<DeterministicSandboxLeaseIdentity<Handle>>,
    acquisition: number
  ) => void | PromiseLike<void>
  readonly #releases: string[] = []
  readonly #spawn: NonNullable<DeterministicSandboxProviderOptions<Handle>["spawn"]>
  /** Stable provider identifier configured for this fixture. */
  readonly name: string

  /**
   * Captures deterministic hooks without acquiring any resources.
   */
  constructor(options: DeterministicSandboxProviderOptions<Handle> = {}) {
    const name = options.name ?? "deterministic-sandbox"

    if (name.length === 0) {
      throw new TypeError("Deterministic Sandbox provider name must not be empty")
    }

    if (name !== name.trim()) {
      throw new TypeError("Deterministic Sandbox provider name must already be normalized")
    }

    this.name = name
    this.#createHandle =
      options.createHandle ??
      ((request, acquisition) =>
        ({
          acquisition,
          kind: "deterministic-sandbox",
          request,
        }) as Handle)
    this.#exec =
      options.exec ??
      ((command: string, args: readonly string[]) => ({
        exitCode: 0,
        stderr: "",
        stdout: [command, ...args].join(" "),
      }))
    this.#release = options.release ?? (() => {})
    this.#spawn =
      options.spawn ??
      ((command: string, args: readonly string[]) =>
        completedProcess(`deterministic-process:${command}`, [command, ...args].join(" ")))
  }

  /**
   * Returns acquisition requests in provider call order.
   */
  get acquisitions(): readonly SandboxAcquireRequest[] {
    return this.#acquisitions
  }

  /**
   * Returns lease ids in provider release order.
   */
  get releases(): readonly string[] {
    return this.#releases
  }

  /**
   * Creates one deterministic opaque lease and records its eventual release.
   */
  async acquire(request: SandboxAcquireRequest): Promise<SandboxLease<Handle>> {
    const acquisition = this.#acquisitions.length
    this.#acquisitions.push(request)
    const handle = await this.#createHandle(request, acquisition)
    const id = `${this.name}-${acquisition + 1}`
    const directories = new Set<string>([request.root])
    const files = new Map<string, Uint8Array>()
    const modifiedAt = new Map<string, number>()
    let revision = 0
    const addParents = (filePath: string): void => {
      let parent = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "."

      while (parent !== "." && !directories.has(parent)) {
        directories.add(parent)
        parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "."
      }
    }
    const runtime: SandboxRuntime = Object.freeze({
      access: request.access,
      createFileStaging: async () => {
        const root = `/tmp/aml-agent-${id}`
        let released = false

        return Object.freeze({
          async release() {
            if (released) {
              return
            }

            released = true

            for (const filePath of files.keys()) {
              if (filePath.startsWith(`${root}/`)) {
                files.delete(filePath)
                modifiedAt.delete(filePath)
              }
            }
          },
          root,
          async writeFile(filePath: string, content: Uint8Array) {
            const destination = `${root}/${filePath}`
            addParents(destination)
            files.set(destination, Uint8Array.from(content))
            modifiedAt.set(destination, ++revision)
          },
        })
      },
      cwd: request.cwd,
      exec: async (command: string, args: readonly string[] = [], options = {}) =>
        await this.#exec(command, args, request, options),
      async readFile(filePath: string) {
        const content = files.get(filePath)

        if (content === undefined) {
          throw new Error(`Deterministic Sandbox file "${filePath}" does not exist`)
        }

        return Uint8Array.from(content)
      },
      root: request.root,
      spawn: async (command: string, args: readonly string[] = [], options: Readonly<SandboxExecOptions> = {}) => {
        if (command === "cat" && args.length === 1) {
          const filePath = path.posix.normalize(path.posix.join(options.cwd ?? request.cwd, args[0]!))
          const content = files.get(filePath)
          if (content !== undefined) return completedProcess(`deterministic-process:${command}`, content)
        }

        return await this.#spawn(command, args, request, options)
      },
      async stat(filePath: string) {
        const content = files.get(filePath)

        if (content !== undefined) {
          return Object.freeze({
            kind: "file" as const,
            modifiedAtMs: modifiedAt.get(filePath) ?? 0,
            size: content.byteLength,
          })
        }

        if (directories.has(filePath)) {
          return Object.freeze({ kind: "directory" as const, modifiedAtMs: 0, size: 0 })
        }

        throw new Error(`Deterministic Sandbox file "${filePath}" does not exist`)
      },
      async writeFile(filePath: string, content: Uint8Array) {
        if (request.access !== "read-write") {
          throw new Error("Deterministic Sandbox filesystem is read-only")
        }

        addParents(filePath)
        files.set(filePath, Uint8Array.from(content))
        modifiedAt.set(filePath, ++revision)
      },
    })

    return Object.freeze({
      handle,
      id,
      runtime,
      release: async () => {
        this.#releases.push(id)
        await this.#release(Object.freeze({ handle, id }), acquisition)
      },
    })
  }
}

function completedProcess(id: string, stdout: string | Uint8Array): Readonly<SandboxProcess> {
  return Object.freeze({
    id,
    async kill() {},
    stdin: new WritableStream(),
    stderr: byteStream(""),
    stdout: byteStream(stdout),
    async wait() {
      return Object.freeze({ exitCode: 0 })
    },
  })
}

function byteStream(value: string | Uint8Array): ReadableStream<Uint8Array> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) {
        controller.enqueue(bytes)
      }
      controller.close()
    },
  })
}
