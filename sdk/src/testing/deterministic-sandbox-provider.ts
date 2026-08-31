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
    const runtime: SandboxRuntime = Object.freeze({
      access: request.access,
      cwd: request.cwd,
      exec: async (command: string, args: readonly string[] = [], options = {}) =>
        await this.#exec(command, args, request, options),
      root: request.root,
      spawn: async (command: string, args: readonly string[] = [], options = {}) =>
        await this.#spawn(command, args, request, options),
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

function completedProcess(id: string, stdout: string): Readonly<SandboxProcess> {
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

function byteStream(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value)
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) {
        controller.enqueue(bytes)
      }
      controller.close()
    },
  })
}
