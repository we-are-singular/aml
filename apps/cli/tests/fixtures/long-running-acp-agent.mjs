import { writeFileSync } from "node:fs"
import process from "node:process"
import { Readable, Writable } from "node:stream"

import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk"

const sessions = new Set()
let finishPrompt

agent({ name: "aml-cli-signal-fixture" })
  .onRequest(methods.agent.initialize, () => ({
    agentCapabilities: { loadSession: false, mcpCapabilities: { http: true } },
    protocolVersion: PROTOCOL_VERSION,
  }))
  .onRequest(methods.agent.session.new, () => {
    const sessionId = "aml-cli-signal-session"
    sessions.add(sessionId)
    return { sessionId }
  })
  .onRequest(methods.agent.session.prompt, async ({ params }) => {
    if (!sessions.has(params.sessionId)) throw new Error(`Unknown session ${params.sessionId}`)
    writeFileSync(process.env.AML_SIGNAL_TEST_PROMPT_FILE, "ready")
    await new Promise(resolve => (finishPrompt = resolve))
    return { stopReason: "cancelled" }
  })
  .onNotification(methods.agent.session.cancel, () => finishPrompt?.())
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))

writeFileSync(process.env.AML_SIGNAL_TEST_ACP_PID_FILE, String(process.pid))
