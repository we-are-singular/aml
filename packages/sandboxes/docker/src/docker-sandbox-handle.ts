import type { SandboxAccess } from "@aml/sdk"

/**
 * Captured stdout, stderr, and process status from one container command.
 */
export interface DockerCommandResult {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

/**
 * Effective working directory and optional cancellation for one command.
 */
export interface DockerExecOptions {
  /**
   * Effective AML Sandbox or Agent cwd for this command.
   */
  readonly cwd: string
  readonly signal?: AbortSignal
}

/**
 * Opaque Docker capability passed through an AML Sandbox session.
 */
export interface DockerSandboxHandle {
  readonly access: SandboxAccess
  readonly containerId: string

  /**
   * Executes an argument array directly inside the leased container.
   */
  exec(
    command: readonly string[],
    options: DockerExecOptions,
  ): Promise<DockerCommandResult>

  readonly kind: "docker"
  readonly root: string
}
