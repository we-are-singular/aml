import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { resolvePortablePath } from "../../core/resolve-portable-path.js"
import type { SandboxFileOptions, SandboxFileStat } from "./sandbox-runtime.js"

/**
 * Safe complete-file operations beneath one trusted host directory.
 *
 * Local and bind-mounted Sandbox providers use this owner so component and
 * provider code share the same traversal, symlink, and atomic-write behavior.
 */
export class HostSandboxFileSystem {
  readonly #root: string

  /** Captures the physical boundary without performing filesystem I/O. */
  constructor(root: string) {
    if (typeof root !== "string" || root.length === 0) {
      throw new TypeError("Host Sandbox filesystem root must be a non-empty string")
    }

    this.#root = path.resolve(root)
  }

  /** Reads one complete regular file without following a leaf symlink. */
  async readFile(portablePath: string, options: Readonly<SandboxFileOptions> = {}): Promise<Uint8Array> {
    options.signal?.throwIfAborted()
    const target = await this.#resolveExisting(portablePath, "file")
    const content = await readFile(target, options.signal === undefined ? undefined : { signal: options.signal })
    options.signal?.throwIfAborted()
    return Uint8Array.from(content)
  }

  /** Returns regular-file or directory metadata without following symlinks. */
  async stat(portablePath: string, options: Readonly<SandboxFileOptions> = {}): Promise<Readonly<SandboxFileStat>> {
    options.signal?.throwIfAborted()
    const normalized = resolvePortablePath(".", portablePath, "Sandbox file path")
    const physicalRoot = await realpath(this.#root)

    if (normalized === ".") {
      return Object.freeze({ kind: "directory" as const, size: 0 })
    }

    const target = await this.#resolveExistingFromRoot(physicalRoot, normalized)
    const metadata = await lstat(target)
    options.signal?.throwIfAborted()

    if (metadata.isSymbolicLink()) {
      throw new TypeError("Sandbox file path must not resolve through a symbolic link")
    }

    if (metadata.isFile()) {
      return Object.freeze({ kind: "file" as const, size: metadata.size })
    }

    if (metadata.isDirectory()) {
      return Object.freeze({ kind: "directory" as const, size: 0 })
    }

    throw new TypeError("Sandbox file path must identify a regular file or directory")
  }

  /** Creates safe parents and atomically replaces one regular file. */
  async writeFile(
    portablePath: string,
    content: Uint8Array,
    options: Readonly<SandboxFileOptions> = {}
  ): Promise<void> {
    options.signal?.throwIfAborted()

    if (!(content instanceof Uint8Array)) {
      throw new TypeError("Sandbox file content must be a Uint8Array")
    }

    const normalized = resolvePortablePath(".", portablePath, "Sandbox file path")

    if (normalized === ".") {
      throw new TypeError("Sandbox file path must identify a file")
    }

    const physicalRoot = await realpath(this.#root)
    const parent = await ensureSafeParent(physicalRoot, path.posix.dirname(normalized))
    const destination = path.join(parent, path.posix.basename(normalized))
    await rejectUnsafeDestination(destination)

    const temporary = path.join(parent, `.aml-file-${randomUUID()}.tmp`)

    try {
      await writeFile(temporary, content, {
        flag: "wx",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      await rename(temporary, destination)
    } finally {
      await rm(temporary, { force: true })
    }

    options.signal?.throwIfAborted()
  }

  async #resolveExisting(portablePath: string, expected: "file"): Promise<string> {
    const normalized = resolvePortablePath(".", portablePath, "Sandbox file path")

    if (normalized === ".") {
      throw new TypeError(`Sandbox file path must identify a regular ${expected}`)
    }

    const physicalRoot = await realpath(this.#root)
    const target = await this.#resolveExistingFromRoot(physicalRoot, normalized)
    const metadata = await lstat(target)

    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new TypeError(`Sandbox file path must identify a regular ${expected}`)
    }

    return target
  }

  async #resolveExistingFromRoot(physicalRoot: string, portablePath: string): Promise<string> {
    const parent = await realpath(path.join(physicalRoot, ...path.posix.dirname(portablePath).split("/")))
    assertWithin(physicalRoot, parent)
    return path.join(parent, path.posix.basename(portablePath))
  }
}

/** Creates missing directories while rejecting every existing symlink. */
async function ensureSafeParent(physicalRoot: string, portableParent: string): Promise<string> {
  let current = physicalRoot

  for (const segment of portableParent === "." ? [] : portableParent.split("/")) {
    current = path.join(current, segment)

    try {
      const metadata = await lstat(current)

      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new TypeError(`Sandbox file parent "${segment}" is not a directory`)
      }
    } catch (cause) {
      if (!hasErrorCode(cause, "ENOENT")) {
        throw cause
      }

      await mkdir(current)
    }
  }

  assertWithin(physicalRoot, current)
  return current
}

async function rejectUnsafeDestination(destination: string): Promise<void> {
  try {
    const metadata = await lstat(destination)

    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new TypeError("Sandbox file destination must be a regular file")
    }
  } catch (cause) {
    if (!hasErrorCode(cause, "ENOENT")) {
      throw cause
    }
  }
}

function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(root, candidate)

  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new TypeError("Sandbox file path resolves outside its root")
  }
}

function hasErrorCode(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "code") === code
}
