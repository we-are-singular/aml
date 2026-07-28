import type { SandboxSession } from "@aml-jsx/sdk"

import type { DockerSandboxHandle } from "./docker-sandbox-handle.js"

/**
 * Narrows sessions whose effective policy is enforced by their Docker lease.
 *
 * One bind mount cannot enforce a nested root or access downgrade, so those
 * restrictive AML views correctly fail this compatibility handshake.
 */
export function supportsDockerSandbox(session: SandboxSession): session is SandboxSession<DockerSandboxHandle> {
  try {
    const handle = session.lease.handle as Partial<DockerSandboxHandle>

    return (
      typeof handle === "object" &&
      handle !== null &&
      handle.kind === "docker" &&
      typeof handle.containerId === "string" &&
      typeof handle.exec === "function" &&
      session.provider.name === "docker" &&
      session.root === handle.root &&
      session.access === handle.access
    )
  } catch {
    // Compatibility checks receive external session/handle values and must
    // fail closed rather than turn a hostile getter into provider execution.
    return false
  }
}
