import { lstat, readFile } from "node:fs/promises"
import path from "node:path"

import { EvaluationError } from "../../core/evaluation-error.js"
import type { SandboxSession } from "../sandbox/sandbox-provider.js"
import type { WorkspaceMaterializationReference } from "../workspace/workspace-provider.js"
import { ActiveFilesystem } from "./active-filesystem.js"
import type { FileProps } from "./file.js"

/** Immutable File destination and source captured before child effects. */
export interface FileEvaluation {
  readonly filesystem: ActiveFilesystem
  readonly hasChildren: boolean
  readonly path: string
  readonly source: string | undefined
}

/** Owns File source validation and nearest-filesystem writes. */
export class FileEvaluator {
  readonly #cwd: string

  /** Captures the application directory for local `src` reads. */
  constructor(cwd: string) {
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new TypeError("cwd must be a non-empty string")
    }

    this.#cwd = path.resolve(cwd)
  }

  /** Captures the destination before child Agents or components perform effects. */
  prepare(
    props: Readonly<FileProps>,
    workspace: Readonly<WorkspaceMaterializationReference> | undefined,
    sandbox: Readonly<SandboxSession> | undefined
  ): Readonly<FileEvaluation> {
    const filesystem = ActiveFilesystem.capture(workspace, sandbox)

    if (filesystem === undefined) {
      throw new EvaluationError("<File> requires an enclosing <Workspace> or <Sandbox>")
    }

    const children = Reflect.get(props, "children")
    const source = Reflect.get(props, "src")
    const hasChildren = children !== undefined
    const hasSource = source !== undefined

    if (hasChildren === hasSource) {
      throw new EvaluationError("<File> requires exactly one of src or children")
    }

    if (hasSource && (typeof source !== "string" || source.length === 0 || source !== source.trim())) {
      throw new EvaluationError("<File> src must be a non-empty normalized string")
    }

    return Object.freeze({
      filesystem,
      hasChildren,
      path: filesystem.resolvePath(Reflect.get(props, "path"), "<File> path"),
      source: hasSource ? path.resolve(this.#cwd, source as string) : undefined,
    })
  }

  /** Reads the chosen source and replaces the destination through its owner. */
  async complete(plan: Readonly<FileEvaluation>, childContent: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    let content: Uint8Array

    try {
      content =
        plan.source === undefined ? new TextEncoder().encode(childContent) : await readLocalUtf8(plan.source, signal)
      await plan.filesystem.writeFile(plan.path, content, signal)
    } catch (cause) {
      signal.throwIfAborted()

      if (cause instanceof EvaluationError) {
        throw cause
      }

      throw new EvaluationError(`<File> could not write "${plan.path}"`, { cause })
    }
  }
}

async function readLocalUtf8(source: string, signal: AbortSignal): Promise<Uint8Array> {
  try {
    const metadata = await lstat(source)

    if (!metadata.isFile()) {
      throw new EvaluationError("<File> src must identify a regular file")
    }

    const content = await readFile(source, { signal })
    new TextDecoder("utf-8", { fatal: true }).decode(content)
    return Uint8Array.from(content)
  } catch (cause) {
    signal.throwIfAborted()

    if (cause instanceof EvaluationError) {
      throw cause
    }

    throw new EvaluationError(`<File> could not read local source "${source}"`, { cause })
  }
}
