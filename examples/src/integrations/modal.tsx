import { resolve } from "node:path"

import { Agent, modalSandbox, Sandbox, supportsSandboxRuntime } from "@aml-jsx/sdk"
import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"

/**
 * Creates a real Modal Sandbox using the SDK's normal credential discovery.
 */
const ExampleSandbox = modalSandbox({
  image: process.env.AML_MODAL_IMAGE ?? "alpine:3.22",
  workspace: resolve(import.meta.dirname, "../../.."),
})

/**
 * Inspects Modal through the same runtime available to any Agent adapter.
 */
const ExampleProvider = new DeterministicAgentProvider({
  name: "modal-inspection-example",
  supportsSandbox: supportsSandboxRuntime,
  async respond(_request, context) {
    const sandbox = context.sandbox

    if (sandbox === undefined || !supportsSandboxRuntime(sandbox)) {
      throw new Error("Modal example requires its Sandbox lease")
    }

    const result = await sandbox.lease.runtime.exec("sh", ["-lc", 'printf "cwd=%s\\nruntime=common\\n" "$PWD"'], {
      cwd: sandbox.cwd,
      signal: context.signal,
    })

    if (result.exitCode !== 0) {
      throw new Error(`Modal inspection failed: ${result.stderr || result.stdout}`)
    }

    return { text: result.stdout.trim() }
  },
})

/**
 * Demonstrates an Agent adapter executing through a Modal Sandbox.
 */
export default function ModalExample() {
  return (
    <Sandbox provider={ExampleSandbox} access="read-write">
      <Agent cwd="sdk" provider={ExampleProvider}>
        Inspect the active Modal confinement.
      </Agent>
    </Sandbox>
  )
}
