import type { SandboxLeaseReference, SandboxProvider } from "./sandbox-provider.js"
import { validateSandboxRuntime } from "./validate-sandbox-runtime.js"

/**
 * Captured provider members used without rereading mutable public properties.
 */
export interface ValidatedSandboxProvider {
  readonly acquire: SandboxProvider["acquire"]
  readonly name: string
  readonly provider: SandboxProvider
}

/**
 * Captured lease members used without trusting mutable provider objects.
 */
export interface ValidatedSandboxLease {
  readonly lease: Readonly<SandboxLeaseReference>
  readonly release: () => Promise<void>
}

/**
 * Release method captured before the remaining external lease is inspected.
 */
export interface SandboxLeaseCapture {
  readonly release: () => Promise<void>
  readonly value: object
}

/**
 * Validates a Sandbox provider and captures the members one acquisition uses.
 */
export function validateSandboxProvider(value: unknown): Readonly<ValidatedSandboxProvider> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Sandbox provider must be an object")
  }

  const candidate = value as {
    readonly acquire?: unknown
    readonly name?: unknown
  }
  const name = candidate.name
  const acquire = candidate.acquire

  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("Sandbox provider name must be a non-empty string")
  }

  if (name !== name.trim()) {
    throw new TypeError("Sandbox provider name must already be normalized")
  }

  if (typeof acquire !== "function") {
    throw new TypeError("Sandbox provider acquire must be a function")
  }

  return Object.freeze({
    acquire: acquire as SandboxProvider["acquire"],
    name,
    provider: value as SandboxProvider,
  })
}

/**
 * Validates and snapshots a provider-created lease.
 *
 * `release` is read first so callers can still clean up when a later lease
 * field is malformed or exposed through a throwing accessor.
 */
export function captureSandboxLease(value: unknown, providerName: string): Readonly<SandboxLeaseCapture> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`Sandbox provider "${providerName}" returned an invalid lease`)
  }

  const candidate = value as {
    readonly release?: unknown
  }
  let release: unknown

  try {
    release = candidate.release
  } catch (cause) {
    throw new TypeError(`Sandbox provider "${providerName}" returned a lease with an unreadable release method`, {
      cause,
    })
  }

  if (typeof release !== "function") {
    throw new TypeError(`Sandbox provider "${providerName}" returned a lease without release()`)
  }

  return Object.freeze({
    async release() {
      await Reflect.apply(release, value, [])
    },
    value,
  })
}

/**
 * Validates and snapshots a lease after its cleanup method has been captured.
 */
export function validateSandboxLease(
  capture: SandboxLeaseCapture,
  providerName: string
): Readonly<ValidatedSandboxLease> {
  const candidate = capture.value as {
    readonly handle?: unknown
    readonly id?: unknown
    readonly runtime?: unknown
  }
  let handle: unknown
  let id: unknown
  let runtime: unknown

  try {
    id = candidate.id
    handle = candidate.handle
    runtime = candidate.runtime
  } catch (cause) {
    throw new TypeError(`Sandbox provider "${providerName}" returned a lease with unreadable identity data`, { cause })
  }

  if (typeof id !== "string" || id.length === 0 || id !== id.trim()) {
    throw new TypeError(`Sandbox provider "${providerName}" returned a lease with an invalid id`)
  }

  // Descendants receive stable identity data without the lifecycle method that
  // remains private to the evaluator.
  const lease: SandboxLeaseReference = Object.freeze({
    handle,
    id,
    runtime: validateSandboxRuntime(runtime, providerName),
  })

  return Object.freeze({
    lease,
    release: capture.release,
  })
}
