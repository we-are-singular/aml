import { cwd } from "node:process"

import { localSandbox, Sandbox, Script } from "@aml-jsx/sdk"

export default (
  <Sandbox access="read-write" provider={localSandbox({ workspace: cwd() })}>
    <Script shell="sh">
      {`sleep 300 & child=$!; printf '%s\\n' "$child" > "$AML_SIGNAL_TEST_PID_FILE"; wait "$child"`}
    </Script>
  </Sandbox>
)
