import { cwd } from "node:process"

import { localSandbox, Sandbox, Script } from "@aml-jsx/sdk"

/**
 * Keeps one real process tree active until the CLI cancels the evaluation.
 *
 * The local provider runs trusted commands on the host. The optional PID file
 * makes process cleanup independently verifiable after interrupting the CLI.
 */
const LongRunningProcess = (
  <Sandbox access="read-write" provider={localSandbox({ workspace: cwd() })}>
    <Script shell="sh">
      {String.raw`
sleep 300 &
child=$!

if [ -n "$AML_PROCESS_SAFETY_PID_FILE" ]; then
  printf '%s\n' "$child" > "$AML_PROCESS_SAFETY_PID_FILE"
fi

wait "$child"
`}
    </Script>
  </Sandbox>
)

// Export the AML tree itself. The CLI must own AmlRuntime construction so its
// SIGINT/SIGTERM cancellation covers the Script and Sandbox release boundary.
export default LongRunningProcess
