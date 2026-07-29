import type { SandboxAcquireRequest, SandboxLease, SandboxProvider } from "../components/sandbox/sandbox-provider.js"
import type { SandboxExecResult, SandboxRuntime } from "../components/sandbox/sandbox-runtime.js"

/**
 * Default opaque handle exposed by the deterministic Sandbox fixture.
 */
export interface DeterministicSandboxHandle {
  readonly acquisition: number
  readonly kind: "deterministic-sandbox"
  readonly request: SandboxAcquireRequest
}

/**
 * Configuration hooks for deterministic acquisition and release behavior.
 */
export interface DeterministicSandboxProviderOptions<Handle> {
  readonly createHandle?: (request: SandboxAcquireRequest, acquisition: number) => Handle | PromiseLike<Handle>
  readonly exec?: (
    command: string,
    args: readonly string[],
    request: SandboxAcquireRequest
  ) => SandboxExecResult | PromiseLike<SandboxExecResult>
  readonly name?: string
  readonly release?: (lease: Readonly<{ handle: Handle; id: string }>, acquisition: number) => void | PromiseLike<void>
}

/**
 * Records Sandbox lifecycle calls without creating real infrastructure.
 */
export class DeterministicSandboxProvider<Handle = DeterministicSandboxHandle> implements SandboxProvider<Handle> {
  readonly #acquisitions: SandboxAcquireRequest[] = []
  readonly #createHandle: (request: SandboxAcquireRequest, acquisition: number) => Handle | PromiseLike<Handle>
  readonly #exec: NonNullable<DeterministicSandboxProviderOptions<Handle>["exec"]>
  readonly #release: (lease: Readonly<{ handle: Handle; id: string }>, acquisition: number) => void | PromiseLike<void>
  readonly #releases: string[] = []
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
      exec: async (command: string, args: readonly string[] = []) => await this.#exec(command, args, request),
      root: request.root,
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
