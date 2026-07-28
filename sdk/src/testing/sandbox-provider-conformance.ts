import type { SandboxAcquireRequest, SandboxProvider } from "../components/sandbox/sandbox-provider.js"
import {
  captureSandboxLease,
  validateSandboxLease,
  validateSandboxProvider,
} from "../components/sandbox/validate-sandbox-provider.js"

/**
 * Exercises one complete provider-neutral Sandbox lease lifecycle.
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
    validateSandboxLease(capture, validatedProvider.name)
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
