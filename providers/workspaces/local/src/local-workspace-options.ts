import path from "node:path"

const DEFAULT_STALE_MS = 30_000
const DEFAULT_UPDATE_MS = 10_000
const MAXIMUM_TIMER_MS = 2_147_483_647
const MINIMUM_STALE_MS = 2_000
const MINIMUM_UPDATE_MS = 1_000

/**
 * Local durable directory captured by `localWorkspace()`.
 */
export interface LocalWorkspaceOptions {
  readonly directory: string

  /**
   * Time without a successful heartbeat before another process may recover it.
   */
  readonly staleMs?: number

  /**
   * Heartbeat interval, bounded to at most half of `staleMs`.
   */
  readonly updateMs?: number
}

/**
 * Complete immutable configuration consumed by the local provider.
 */
export interface ParsedLocalWorkspaceOptions {
  readonly directory: string
  readonly staleMs: number
  readonly updateMs: number
}

/**
 * Validates configuration without reading or creating filesystem entries.
 */
export function parseLocalWorkspaceOptions(value: LocalWorkspaceOptions): Readonly<ParsedLocalWorkspaceOptions> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Local Workspace options must be an object")
  }

  let directory: unknown

  try {
    // Configuration is external input. Capture it once so getters cannot
    // redirect filesystem authority after validation.
    directory = value.directory
  } catch (cause) {
    throw new TypeError("Local Workspace directory must be readable", { cause })
  }

  if (typeof directory !== "string" || directory.length === 0 || directory !== directory.trim()) {
    throw new TypeError("Local Workspace directory must be a non-empty normalized string")
  }

  const staleMs = requireBoundedInteger(
    value.staleMs ?? DEFAULT_STALE_MS,
    "Local Workspace staleMs",
    MINIMUM_STALE_MS,
    MAXIMUM_TIMER_MS
  )
  const updateMs = requireBoundedInteger(
    value.updateMs ?? DEFAULT_UPDATE_MS,
    "Local Workspace updateMs",
    MINIMUM_UPDATE_MS,
    MAXIMUM_TIMER_MS
  )

  if (updateMs > staleMs / 2) {
    throw new RangeError("Local Workspace updateMs must not exceed half of staleMs")
  }

  return Object.freeze({
    directory: path.resolve(directory),
    staleMs,
    updateMs,
  })
}

/**
 * Keeps lock timing inside proper-lockfile's supported integer range.
 */
function requireBoundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a safe integer from ${minimum} through ${maximum}`)
  }

  return value
}
