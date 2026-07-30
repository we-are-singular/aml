import { EvaluationError } from "../../core/evaluation-error.js"
import { resolvePortablePath } from "../../core/resolve-portable-path.js"
import type { WorkspaceMaterializationReference } from "../workspace/workspace-provider.js"
import type { SandboxProps } from "./sandbox.js"
import type {
  SandboxAccess,
  SandboxAcquireRequest,
  SandboxProvider,
  SandboxProviderReference,
  SandboxSession,
} from "./sandbox-provider.js"
import {
  captureSandboxLease,
  type ValidatedSandboxProvider,
  validateSandboxLease,
  validateSandboxProvider,
} from "./validate-sandbox-provider.js"

/**
 * Runtime-owned view of one entered Sandbox scope.
 */
export interface SandboxEvaluationScope {
  readonly ownsLease: boolean
  readonly session: Readonly<SandboxSession>

  /**
   * Releases an outer lease once; nested scopes complete without provider I/O.
   */
  release(): Promise<void>
}

/**
 * Owns Sandbox policy validation, acquisition, nesting, and release attribution.
 */
export class SandboxEvaluator {
  readonly #provider: Readonly<ValidatedSandboxProvider> | undefined
  readonly #workspaceWrites = new WeakMap<WorkspaceMaterializationReference, WorkspaceWriteQueue>()

  /**
   * Captures the optional runtime-wide provider without acquiring resources.
   */
  constructor(provider?: SandboxProvider) {
    this.#provider = provider === undefined ? undefined : validateSandboxProvider(provider)
  }

  /**
   * Enters a root Sandbox or creates a restrictive view of its parent lease.
   */
  async enter(
    props: Readonly<SandboxProps>,
    parent: Readonly<SandboxSession> | undefined,
    workspace: Readonly<WorkspaceMaterializationReference> | undefined,
    evaluationId: string,
    signal: AbortSignal
  ): Promise<Readonly<SandboxEvaluationScope>> {
    return parent === undefined
      ? await this.#acquireRoot(props, workspace, evaluationId, signal)
      : this.#enterNested(props, parent)
  }

  /**
   * Applies an Agent-local working directory without widening Sandbox scope.
   */
  forAgent(session: Readonly<SandboxSession> | undefined, cwd: unknown): Readonly<SandboxSession> | undefined {
    if (cwd === undefined) {
      return session
    }

    if (session === undefined) {
      throw new EvaluationError("<Agent> cwd requires an enclosing <Sandbox>")
    }

    return Object.freeze({
      ...session,
      cwd: resolvePortablePath(session.root, cwd, "<Agent> cwd"),
    })
  }

  /**
   * Acquires the one provider lease owned by an outermost Sandbox.
   */
  async #acquireRoot(
    props: Readonly<SandboxProps>,
    workspace: Readonly<WorkspaceMaterializationReference> | undefined,
    evaluationId: string,
    signal: AbortSignal
  ): Promise<Readonly<SandboxEvaluationScope>> {
    const provider = props.provider === undefined ? this.#provider : validateSandboxProvider(props.provider)

    if (provider === undefined) {
      throw new EvaluationError("<Sandbox> requires a provider or AmlRuntime sandboxProvider")
    }

    const request = createRootRequest(props, workspace, evaluationId, signal)
    const releaseWorkspaceWrite = await this.#acquireWorkspaceWrite(request, workspace)
    let value: unknown

    try {
      value = await Reflect.apply(provider.acquire, provider.provider, [Object.freeze(request)])
    } catch (cause) {
      releaseWorkspaceWrite()
      // Cancellation is caller-owned control flow, not an attributed provider
      // failure. Cooperative providers reject pending acquisition with it.
      signal.throwIfAborted()
      throw new EvaluationError(`Sandbox provider "${provider.name}" failed to acquire`, { cause })
    }

    let capture: ReturnType<typeof captureSandboxLease>

    try {
      capture = captureSandboxLease(value, provider.name)
    } catch (error) {
      releaseWorkspaceWrite()
      throw error
    }

    let lease: ReturnType<typeof validateSandboxLease>

    try {
      lease = validateSandboxLease(capture, provider.name)
    } catch (leaseError) {
      // A provider may allocate real infrastructure before returning a malformed
      // lease. If release was capturable, clean that resource up immediately.
      try {
        await capture.release()
      } catch (releaseError) {
        releaseWorkspaceWrite()
        throw new AggregateError(
          [leaseError, releaseError],
          `Sandbox provider "${provider.name}" returned an invalid lease and cleanup failed`
        )
      }

      releaseWorkspaceWrite()
      throw leaseError
    }

    const providerReference: SandboxProviderReference = Object.freeze({
      name: provider.name,
    })
    const session: Readonly<SandboxSession> = Object.freeze({
      access: request.access,
      cwd: request.cwd,
      lease: lease.lease,
      nested: false,
      provider: providerReference,
      root: request.root,
    })
    let releasePromise: Promise<void> | undefined

    return Object.freeze({
      ownsLease: true,
      session,
      release() {
        // Cache the complete release operation so every runtime cleanup path
        // converges on one provider call, even when failures race.
        releasePromise ??= (async () => {
          try {
            await releaseSandboxLease(provider.name, lease.lease.id, lease.release)
          } finally {
            releaseWorkspaceWrite()
          }
        })()
        return releasePromise
      },
    })
  }

  async #acquireWorkspaceWrite(
    request: Readonly<SandboxAcquireRequest>,
    workspace: Readonly<WorkspaceMaterializationReference> | undefined
  ): Promise<() => void> {
    if (request.access !== "read-write" || workspace === undefined || workspace.writeConcurrency === "parallel") {
      return () => {}
    }

    let queue = this.#workspaceWrites.get(workspace)

    if (queue === undefined) {
      queue = new WorkspaceWriteQueue()
      this.#workspaceWrites.set(workspace, queue)
    }

    return await queue.acquire(request.signal)
  }

  /**
   * Creates a narrower policy view without acquiring new infrastructure.
   */
  #enterNested(props: Readonly<SandboxProps>, parent: Readonly<SandboxSession>): Readonly<SandboxEvaluationScope> {
    if (props.provider !== undefined) {
      throw new EvaluationError("A nested <Sandbox> cannot select a provider; it inherits the parent lease")
    }

    const access = validateSandboxAccess(props.access ?? parent.access)

    if (parent.access === "read-only" && access === "read-write") {
      throw new EvaluationError("A nested <Sandbox> cannot widen read-only access to read-write")
    }

    const root = props.root === undefined ? parent.root : resolvePortablePath(parent.root, props.root, "<Sandbox> root")
    const cwd =
      props.cwd !== undefined
        ? resolvePortablePath(root, props.cwd, "<Sandbox> cwd")
        : props.root !== undefined
          ? root
          : parent.cwd
    const session: Readonly<SandboxSession> = Object.freeze({
      access,
      cwd,
      lease: parent.lease,
      nested: true,
      provider: parent.provider,
      root,
    })

    return Object.freeze({
      ownsLease: false,
      async release() {},
      session,
    })
  }
}

/**
 * Builds the portable acquisition policy before any provider side effect.
 */
function createRootRequest(
  props: Readonly<SandboxProps>,
  workspace: Readonly<WorkspaceMaterializationReference> | undefined,
  evaluationId: string,
  signal: AbortSignal
): SandboxAcquireRequest {
  const root = resolvePortablePath(".", props.root ?? ".", "<Sandbox> root")
  const cwd =
    props.cwd !== undefined
      ? resolvePortablePath(root, props.cwd, "<Sandbox> cwd")
      : props.root !== undefined
        ? root
        : (workspace?.cwd ?? ".")

  return {
    access: validateSandboxAccess(props.access ?? "read-only"),
    cwd,
    evaluationId,
    root,
    signal,
    ...(workspace === undefined ? {} : { workspace }),
  }
}

/**
 * Rejects unrecognized access values that can enter through plain JavaScript.
 */
function validateSandboxAccess(value: unknown): SandboxAccess {
  if (value !== "read-only" && value !== "read-write") {
    throw new EvaluationError('<Sandbox> access must be "read-only" or "read-write"')
  }

  return value
}

/**
 * Attributes a provider cleanup failure without hiding its original cause.
 */
async function releaseSandboxLease(providerName: string, leaseId: string, release: () => Promise<void>): Promise<void> {
  try {
    await release()
  } catch (cause) {
    throw new EvaluationError(`Sandbox provider "${providerName}" failed to release lease "${leaseId}"`, { cause })
  }
}

/**
 * Serializes writable root Sandboxes that reconcile into one materialization.
 */
class WorkspaceWriteQueue {
  #active = false
  readonly #waiting: WorkspaceWriteWaiter[] = []

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()

    if (!this.#active) {
      this.#active = true
      return this.#releaseOnce()
    }

    return await new Promise<() => void>((resolve, reject) => {
      const waiter: WorkspaceWriteWaiter = {
        abort: () => {
          const index = this.#waiting.indexOf(waiter)

          if (index >= 0) {
            this.#waiting.splice(index, 1)
          }

          reject(signal.reason)
        },
        resolve,
        signal,
      }

      this.#waiting.push(waiter)
      signal.addEventListener("abort", waiter.abort, { once: true })

      if (signal.aborted) {
        waiter.abort()
      }
    })
  }

  #releaseOnce(): () => void {
    let released = false

    return () => {
      if (released) {
        return
      }

      released = true
      this.#advance()
    }
  }

  #advance(): void {
    const next = this.#waiting.shift()

    if (next === undefined) {
      this.#active = false
      return
    }

    next.signal.removeEventListener("abort", next.abort)

    if (next.signal.aborted) {
      next.abort()
      this.#advance()
      return
    }

    next.resolve(this.#releaseOnce())
  }
}

interface WorkspaceWriteWaiter {
  readonly abort: () => void
  readonly resolve: (release: () => void) => void
  readonly signal: AbortSignal
}
