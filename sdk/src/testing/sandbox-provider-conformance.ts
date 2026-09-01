import type { SandboxAcquireRequest, SandboxProvider } from "../components/sandbox/sandbox-provider.js"
import {
  captureSandboxLease,
  validateSandboxLease,
  validateSandboxProvider,
} from "../components/sandbox/validate-sandbox-provider.js"

/**
 * Exercises one complete provider-neutral Sandbox lease lifecycle.
 *
 * The check acquires a read-only Sandbox with logical root and cwd `"."`,
 * validates the returned lease and runtime metadata, and releases the resource
 * even when validation fails after a release function becomes available. It
 * does not execute commands or filesystem operations; provider-specific tests
 * must exercise their behavior. A real provider may create billable external
 * infrastructure; use an isolated test account and cleanup policy.
 *
 * @param provider Provider instance to validate and exercise.
 */
export async function sandboxProviderConformance(provider: SandboxProvider): Promise<void> {
  const validatedProvider = validateSandboxProvider(provider)
  const request: SandboxAcquireRequest = Object.freeze({
    access: "read-only",
    cwd: ".",
    evaluationId: "sandbox-provider-conformance",
    root: ".",
    signal: new AbortController().signal,
  })
  const value = await Reflect.apply(validatedProvider.acquire, validatedProvider.provider, [request])
  const capture = captureSandboxLease(value, validatedProvider.name)
  let releaseAttempted = false

  try {
    const lease = validateSandboxLease(capture, validatedProvider.name)

    if (
      lease.lease.runtime.access !== request.access ||
      lease.lease.runtime.cwd !== request.cwd ||
      lease.lease.runtime.root !== request.root
    ) {
      throw new TypeError(
        `Sandbox provider "${validatedProvider.name}" runtime must preserve the acquired access, cwd, and root`
      )
    }

    releaseAttempted = true
    await capture.release()
  } catch (error) {
    // If validation fails after release was captured, conformance still owns
    // the provider resource and must not abandon it.
    if (!releaseAttempted) {
      try {
        await capture.release()
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          `Sandbox provider "${validatedProvider.name}" failed conformance and cleanup`
        )
      }
    }

    throw error
  }
}
