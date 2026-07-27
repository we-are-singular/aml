import { resolve } from "node:path"

import {
  dockerSandbox,
  supportsDockerSandbox,
} from "@aml/sandbox-docker"
import {
  Agent,
  AmlRuntime,
  Sandbox,
  type AgentExecutionContext,
  type AgentProvider,
  type AgentRequest,
} from "@aml/sdk"

const sandboxProvider = dockerSandbox({
  image: process.env.AML_DOCKER_IMAGE ?? "alpine:3.22",
  workspace: resolve(import.meta.dirname, "../.."),
})

/**
 * Demonstrates how an Agent adapter consumes the provider-specific lease.
 */
class DockerInspectionAgent implements AgentProvider {
  readonly name = "docker-inspection-example"

  /**
   * Accepts only sessions whose Docker mount enforces the effective policy.
   */
  readonly supportsSandbox = supportsDockerSandbox

  /**
   * Runs a deterministic inspection entirely inside the leased container.
   */
  async run(
    _request: AgentRequest,
    context: AgentExecutionContext,
  ): Promise<{ text: string }> {
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
  }
}

const output = await new AmlRuntime({
  agentProvider: new DockerInspectionAgent(),
}).evaluate(
  <Sandbox provider={sandboxProvider} access="read-only">
    <Agent cwd="packages/sdk">
      Inspect the active Docker confinement.
    </Agent>
  </Sandbox>,
)

if (
  !output.includes("cwd=/workspace/packages/sdk") ||
  output.includes("uid=0") ||
  !output.includes("capabilities=0000000000000000") ||
  !output.includes("network=none")
) {
  throw new Error(`Unexpected Docker Sandbox output:\n${output}`)
}

console.log(output)
