import { Agent, AmlRuntime, Sandbox } from "@aml/sdk"
import {
  DeterministicAgentProvider,
  DeterministicSandboxProvider,
} from "@aml/sdk/testing"

const sandboxProvider = new DeterministicSandboxProvider()
const agentProvider = new DeterministicAgentProvider({
  /**
   * Proves the built SDK passes the effective nested scope to the Agent.
   */
  respond(_request, context) {
    const sandbox = context.sandbox

    if (
      sandbox?.access !== "read-only" ||
      sandbox.cwd !== "repository/packages/api/src"
    ) {
      throw new Error("Agent received an unexpected Sandbox session")
    }

    return {
      text: `Inspected ${sandbox.cwd} through ${sandbox.lease.id}.`,
    }
  },
  supportsSandbox(sandbox) {
    return sandbox.provider.name === sandboxProvider.name
  },
})
const output = await new AmlRuntime({ agentProvider }).evaluate(
  <Sandbox
    access="read-write"
    provider={sandboxProvider}
    root="repository"
  >
    <Sandbox access="read-only" root="packages/api">
      <Agent cwd="src">Inspect without modifying files.</Agent>
    </Sandbox>
  </Sandbox>,
)

if (
  sandboxProvider.acquisitions.length !== 1 ||
  sandboxProvider.releases.length !== 1
) {
  throw new Error("Sandbox must acquire and release exactly one lease")
}

console.log(output)
