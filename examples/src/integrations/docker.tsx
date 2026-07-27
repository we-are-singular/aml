import { resolve } from "node:path"

import {
  dockerSandbox,
  supportsDockerSandbox,
} from "@aml/sandbox-docker"
import {
  Agent,
  Sandbox,
} from "@aml/sdk"
import { DeterministicAgentProvider } from "@aml/sdk/testing"

/**
 * Creates the real Docker boundary shared by the example's AML tree.
 */
const ExampleSandbox = dockerSandbox({
  image: process.env.AML_DOCKER_IMAGE ?? "alpine:3.22",
  workspace: resolve(import.meta.dirname, "../.."),
})

/**
 * Inspects the provider-specific Docker lease without exposing it to AML.
 */
const ExampleProvider = new DeterministicAgentProvider({
  name: "docker-inspection-example",
  supportsSandbox: supportsDockerSandbox,
  async respond(_request, context) {
    const sandbox = context.sandbox

    if (sandbox === undefined || !supportsDockerSandbox(sandbox)) {
      throw new Error("Docker example requires its Sandbox lease")
    }

    const result = await sandbox.lease.handle.exec(
      [
        "sh",
        "-c",
        [
          'printf "cwd=%s\\n" "$PWD"',
          'printf "uid=%s\\n" "$(id -u)"',
          "awk '/CapEff/ { printf \"capabilities=%s\\n\", $2 }' /proc/self/status",
          'test ! -e /sys/class/net/eth0 && echo "network=none"',
        ].join("\n"),
      ],
      {
        cwd: sandbox.cwd,
        signal: context.signal,
      },
    )

    if (result.exitCode !== 0) {
      throw new Error(
        `Docker inspection failed: ${result.stderr || result.stdout}`,
      )
    }

    return { text: result.stdout.trim() }
  },
})

/**
 * Demonstrates an Agent executing inside a confined Docker Sandbox.
 */
export default function DockerExample() {
  return (
    <Sandbox provider={ExampleSandbox} access="read-only">
      <Agent cwd="packages/sdk" provider={ExampleProvider}>
        Inspect the active Docker confinement.
      </Agent>
    </Sandbox>
  )
}
