import { fileURLToPath, URL } from "node:url"
import { cwd, env, execPath } from "node:process"

import { Agent, defineAcpAgentProvider, defineTool, localSandbox, Sandbox, Tool } from "@aml-jsx/sdk"
import { z } from "zod"

const fixtureAgent = fileURLToPath(new URL("./long-running-acp-agent.mjs", import.meta.url))
const provider = defineAcpAgentProvider({
  createLaunch() {
    return {
      args: [fixtureAgent],
      command: execPath,
      env: {
        AML_SIGNAL_TEST_ACP_PID_FILE: env.AML_SIGNAL_TEST_ACP_PID_FILE ?? "",
        AML_SIGNAL_TEST_PROMPT_FILE: env.AML_SIGNAL_TEST_PROMPT_FILE ?? "",
      },
      permissionPolicy: "reject_once",
    }
  },
  name: "cli-signal-acp",
  workingDirectory: undefined,
})
const fixtureTool = defineTool({
  description: "Keeps the invocation-owned AML MCP bridge and Sandbox relay active",
  execute: async () => "unused",
  input: z.object({}),
  name: "signal_fixture",
})

export default (
  <Sandbox access="read-write" provider={localSandbox({ workspace: cwd() })}>
    <Agent provider={provider}>
      <Tool use={fixtureTool} />
      Wait until interrupted.
    </Agent>
  </Sandbox>
)
