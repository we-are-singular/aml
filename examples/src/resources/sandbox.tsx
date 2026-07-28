import { Agent, Sandbox } from "@aml-jsx/sdk"
import { DeterministicAgentProvider, DeterministicSandboxProvider } from "@aml-jsx/sdk/testing"

/**
 * Represents the one physical environment leased by the outer Sandbox.
 */
const ExampleSandbox = new DeterministicSandboxProvider()

/**
 * Reports the narrowed Sandbox policy and working directory it receives.
 */
const ExampleProvider = new DeterministicAgentProvider({
  respond(_request, context) {
    const sandbox = context.sandbox

    if (sandbox === undefined) {
      throw new Error("Agent did not receive its Sandbox")
    }

    return {
      text: `Inspected ${sandbox.cwd} through ${sandbox.lease.id}.`,
    }
  },
  supportsSandbox(sandbox) {
    return sandbox.provider.name === ExampleSandbox.name
  },
})

/**
 * Demonstrates nested Sandbox policy narrowing and one shared outer lease.
 */
export default function SandboxExample() {
  return (
    <Sandbox access="read-write" provider={ExampleSandbox} root="repository">
      <Sandbox access="read-only" root="packages/api">
        <Agent provider={ExampleProvider} cwd="src">
          Inspect without modifying files.
        </Agent>
      </Sandbox>
    </Sandbox>
  )
}
