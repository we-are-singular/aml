// Stands in for claude-agent-acp so the provider contract runs over real stdio
// without a paid Claude request. Each event is appended to AML_CLAUDE_FIXTURE_LOG.
import { appendFileSync } from "node:fs"
import process from "node:process"
import { Readable, Writable } from "node:stream"

import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const mode = process.env.AML_CLAUDE_FIXTURE_MODE ?? "reply"
const sessionId = "claude-fixture-session"
let mcpServers = []
let finishPrompt

function log(event) {
  appendFileSync(process.env.AML_CLAUDE_FIXTURE_LOG, `${JSON.stringify(event)}\n`)
}

log({
  argv: process.argv.slice(2),
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    HOME: process.env.HOME,
  },
  type: "launch",
})

// Calls AML's invocation-owned MCP bridge the way Claude Code would.
async function callAmlTools(promptText) {
  const server = mcpServers.find(candidate => candidate.type === "http")
  const client = new Client({ name: "claude-acp-fixture", version: "0.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) },
    })
  )

  try {
    const { tools } = await client.listTools()
    log({ names: tools.map(tool => tool.name), type: "mcp/tools" })
    const proof = await client.callTool({ arguments: {}, name: "claude_proof" })
    const proofText = proof.content.find(block => block.type === "text")?.text
    log({ proof: proofText, type: "mcp/call" })

    if (promptText.includes("aml_submit_result")) {
      const submitted = await client.callTool({
        arguments: { result: { proof: proofText } },
        name: "aml_submit_result",
      })
      log({ isError: submitted.isError === true, type: "mcp/submit" })
    }
  } finally {
    await client.close()
  }
}

const connection = agent({ name: "claude-agent-acp-fixture" })
  .onRequest(methods.agent.initialize, ({ params }) => {
    log({ clientCapabilities: params.clientCapabilities, type: "initialize" })
    // The real adapter advertises no methods unless the client opts into
    // terminal or gateway authentication, which AML never does.
    return {
      agentCapabilities: { mcpCapabilities: { http: true, sse: true } },
      authMethods: [],
      protocolVersion: PROTOCOL_VERSION,
    }
  })
  .onRequest(methods.agent.authenticate, ({ params }) => {
    log({ methodId: params.methodId, type: "authenticate" })
    throw RequestError.methodNotFound("authenticate")
  })
  .onRequest(methods.agent.session.new, ({ params }) => {
    mcpServers = params.mcpServers
    log({ cwd: params.cwd, meta: params._meta, mcpServers: params.mcpServers.map(server => server.name), type: "new" })
    return { sessionId }
  })
  .onRequest(methods.agent.session.prompt, async ({ params }) => {
    const text = params.prompt.flatMap(block => (block.type === "text" ? [block.text] : [])).join("")
    log({ text, type: "prompt" })

    if (mode === "unauthenticated") {
      throw RequestError.authRequired()
    }

    if (mode === "hang") {
      await new Promise(resolve => (finishPrompt = resolve))
      return { stopReason: "cancelled" }
    }

    if (mode === "permission") {
      const response = await connection.client.request(methods.client.session.requestPermission, {
        options: [
          { kind: "allow_always", name: "Always allow", optionId: "allow-with-updates" },
          { kind: "allow_once", name: "Allow", optionId: "allow-once" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
        sessionId,
        toolCall: { kind: "execute", status: "pending", title: "Run tests", toolCallId: "fixture-tool-call" },
      })
      log({ outcome: response.outcome, type: "permission" })
    }

    if (mode === "tool") {
      await callAmlTools(text)
    }

    await connection.client.notify(methods.client.session.update, {
      sessionId,
      update: { content: { text: "fixture reply", type: "text" }, sessionUpdate: "agent_message_chunk" },
    })
    return { stopReason: "end_turn" }
  })
  .onNotification(methods.agent.session.cancel, () => {
    log({ type: "cancel" })
    finishPrompt?.()
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
