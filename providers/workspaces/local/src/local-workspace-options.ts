import path from "node:path"

/**
 * Local durable directory captured by `localWorkspace()`.
 */
export interface LocalWorkspaceOptions {
  readonly directory: string
}

/**
 * Complete immutable configuration consumed by the local provider.
 */
export interface ParsedLocalWorkspaceOptions {
  readonly directory: string
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

  return Object.freeze({
    directory: path.resolve(directory),
  })
}
