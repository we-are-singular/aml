import path from "node:path"

import type { SandboxRuntime } from "../sandbox/sandbox-runtime.js"

export interface SandboxMaterializedFile {
  readonly content: string
  readonly executable?: boolean
  readonly path: string
}

/**
 * Writes invocation-private text files without requiring a provider-specific
 * filesystem API or a synthetic stdin EOF convention.
 */
export async function materializeSandboxFiles(
  runtime: Readonly<SandboxRuntime>,
  root: string,
  files: readonly SandboxMaterializedFile[],
  signal: AbortSignal
): Promise<void> {
  for (const file of files) {
    if (
      file.path.length === 0 ||
      file.path !== file.path.trim() ||
      file.path.includes("\0") ||
      path.posix.isAbsolute(file.path)
    ) {
      throw new TypeError("Sandbox materialized file path must be a normalized relative path")
    }

    const destination = path.posix.resolve(root, file.path)
    if (destination !== root && !destination.startsWith(`${root}/`)) {
      throw new TypeError("Sandbox materialized file path must remain inside its root")
    }

    const directory = path.posix.dirname(destination)
    const prepare = await runtime.exec("mkdir", ["-p", "--", directory], { signal })

    if (prepare.exitCode !== 0) {
      throw new Error(`Could not prepare Sandbox file directory: ${prepare.stderr.trim()}`)
    }

    if (file.content.includes("\0")) {
      throw new TypeError("Sandbox materialized text file cannot contain a null byte")
    }

    // Environment transport avoids command interpolation and works on remote
    // process APIs that can write stdin but cannot signal a real EOF.
    const write = await runtime.exec(
      "sh",
      ["-c", 'umask 077 && printf %s "$AML_MATERIALIZED_FILE" > "$1"', "aml-materialize", destination],
      { env: { AML_MATERIALIZED_FILE: file.content }, signal }
    )

    if (write.exitCode !== 0) {
      throw new Error(`Could not materialize Sandbox file: ${write.stderr.trim()}`)
    }

    const mode = file.executable === true ? "700" : "600"
    const chmod = await runtime.exec("chmod", [mode, "--", destination], { signal })

    if (chmod.exitCode !== 0) {
      throw new Error(`Could not set Sandbox file permissions: ${chmod.stderr.trim()}`)
    }
  }
}
