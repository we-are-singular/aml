import { randomUUID } from "node:crypto"
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { EvaluationError } from "../../core/evaluation-error.js"
import { resolvePortablePath } from "../../core/resolve-portable-path.js"
import type { SandboxSession } from "../sandbox/sandbox-provider.js"
import type { WorkspaceMaterializationReference } from "../workspace/workspace-provider.js"
import type { FileProps } from "./file.js"

export interface FileEvaluation {
  readonly destination: string
  readonly path: string
  readonly root: string
}

/**
 * Validates and writes one authored file beneath the active Workspace root.
 */
export class FileEvaluator {
  /**
   * Captures the destination before child Agents or components perform effects.
   */
  prepare(
    props: Readonly<FileProps>,
    workspace: Readonly<WorkspaceMaterializationReference> | undefined,
    sandbox: Readonly<SandboxSession> | undefined
  ): Readonly<FileEvaluation> {
    if (workspace === undefined) {
      throw new EvaluationError("<File> requires an enclosing <Workspace>")
    }

    // A remote Sandbox may hold a newer guest copy than the host materialization.
    // Guest-side writes need a separate portable filesystem capability.
    if (sandbox !== undefined) {
      throw new EvaluationError("<File> inside <Sandbox> is not supported")
    }

    if (Reflect.get(props, "children") === undefined) {
      throw new EvaluationError("<File> requires children")
    }

    const portablePath = resolvePortablePath(".", Reflect.get(props, "path"), "<File> path")

    if (portablePath === ".") {
      throw new EvaluationError("<File> path must identify a file")
    }

    const root = path.resolve(workspace.directory)
    return Object.freeze({
      destination: path.resolve(root, portablePath),
      path: portablePath,
      root,
    })
  }

  /**
   * Creates safe parents and atomically replaces the destination where possible.
   */
  async complete(plan: Readonly<FileEvaluation>, content: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()

    try {
      await ensureSafeParent(plan.root, path.dirname(plan.path))
      await rejectSymbolicLink(plan.destination)

      const temporary = path.join(path.dirname(plan.destination), `.aml-file-${randomUUID()}.tmp`)

      try {
        await writeFile(temporary, content, { encoding: "utf8", flag: "wx", signal })
        await rename(temporary, plan.destination)
      } finally {
        await rm(temporary, { force: true })
      }
    } catch (cause) {
      signal.throwIfAborted()

      if (cause instanceof EvaluationError) {
        throw cause
      }

      throw new EvaluationError(`<File> could not write "${plan.path}"`, { cause })
    }
  }
}

/**
 * Rejects existing symlink parents instead of following them outside the root.
 */
async function ensureSafeParent(root: string, portableParent: string): Promise<void> {
  const physicalRoot = await realpath(root)
  let current = physicalRoot

  for (const segment of portableParent === "." ? [] : portableParent.split("/")) {
    current = path.join(current, segment)

    try {
      const metadata = await lstat(current)

      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new EvaluationError(`<File> parent "${segment}" is not a directory`)
      }
    } catch (cause) {
      if (!hasErrorCode(cause, "ENOENT")) {
        throw cause
      }

      await mkdir(current)
    }
  }
}

async function rejectSymbolicLink(destination: string): Promise<void> {
  try {
    const metadata = await lstat(destination)

    if (metadata.isSymbolicLink() || metadata.isDirectory()) {
      throw new EvaluationError("<File> destination must be a regular file")
    }
  } catch (cause) {
    if (!hasErrorCode(cause, "ENOENT")) {
      throw cause
    }
  }
}

function hasErrorCode(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "code") === code
}
