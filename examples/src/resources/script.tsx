import { Sandbox, Script } from "@aml-jsx/sdk"
import { DeterministicSandboxProvider } from "@aml-jsx/sdk/testing"

/**
 * Reports the portable working directory passed to the Sandbox runtime.
 */
const ExampleSandbox = new DeterministicSandboxProvider({
  exec(command, args, _request, options) {
    return {
      exitCode: 0,
      stderr: "",
      stdout: `${command} ${args.join(" ")} from ${options.cwd}`,
    }
  },
})

/**
 * Resolves Script cwd from the active Sandbox root.
 */
export default function ScriptExample() {
  return (
    <Sandbox access="read-write" provider={ExampleSandbox} root="repository">
      <Script cwd="packages/api" command="npm" args={["test"]} />
    </Sandbox>
  )
}
