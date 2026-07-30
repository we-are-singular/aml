import path from "node:path"

import { EvaluationError } from "./evaluation-error.js"

/**
 * Resolves one portable relative path while preventing lexical parent escape.
 *
 * Filesystem owners remain responsible for real-path and symlink confinement.
 */
export function resolvePortablePath(base: string, value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EvaluationError(`${label} must be a non-empty string`)
  }

  if (value.includes("\\") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new EvaluationError(`${label} must be a relative forward-slash path`)
  }

  // Reject traversal before normalization so authored paths have identical
  // meaning across providers and operating systems.
  if (value.split("/").includes("..")) {
    throw new EvaluationError(`${label} cannot contain parent traversal`)
  }

  const resolved = path.posix.normalize(path.posix.join(base, path.posix.normalize(value)))

  if (resolved === ".." || resolved.startsWith("../")) {
    throw new EvaluationError(`${label} cannot escape its parent root`)
  }

  return resolved
}
