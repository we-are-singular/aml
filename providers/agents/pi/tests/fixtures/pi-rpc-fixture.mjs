#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

// Exercise the installed ACP adapter without a model request or MCP extension.
// The native failure marker must survive the adapter before AML can preserve it.
const model = { id: "fixture", name: "Fixture", provider: "fixture", reasoning: false, contextWindow: 8192 }
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  const response = { type: "response", command: request.type, id: request.id, success: true }
  if (request.type === "get_state") {
    send({ ...response, data: { model, thinkingLevel: "off", sessionId: `fixture-${process.pid}` } })
  } else if (request.type === "get_available_models") {
    send({ ...response, data: { models: [model] } })
  } else if (request.type === "get_commands") {
    send({ ...response, data: { commands: [] } })
  } else if (request.type === "prompt") {
    appendFileSync(
      process.env.AML_PI_FIXTURE_LOG,
      `${JSON.stringify({ pid: process.pid, home: process.env.HOME, prompt: request.message })}\n`
    )
    if (request.message.includes("fixture:success")) {
      send(response)
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "recovered" } })
      send({ type: "agent_end", messages: [] })
      send({ type: "agent_settled" })
    } else if (["submit", "invalid-then-valid"].includes(process.env.AML_PI_FIXTURE_MODE)) {
      // Call the actual AML bridge while keeping model/proxy behavior outside
      // this fixture. The live tests cover the installed Pi MCP extension.
      const config = JSON.parse(readFileSync(`${process.env.PI_CODING_AGENT_DIR}/mcp.json`, "utf8"))
      const server = config.mcpServers.review
      const client = new Client({ name: "pi-fixture", version: "1.0.0" })
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } })
        )
        for (const result of process.env.AML_PI_FIXTURE_MODE === "invalid-then-valid"
          ? [{ proof: 7 }, { proof: "accepted" }]
          : [{ proof: "accepted" }]) {
          const response = await client.callTool({ name: "aml_submit_result", arguments: { result } })
          appendFileSync(
            process.env.AML_PI_FIXTURE_LOG,
            `${JSON.stringify({ kind: "submission", isError: response.isError === true })}\n`
          )
        }
      } finally {
        await client.close()
      }
      send(response)
      send({ type: "agent_end", messages: [] })
      send({ type: "agent_settled" })
    } else if (process.env.AML_PI_FIXTURE_MODE === "prompt-error") {
      send({ ...response, success: false, error: "ISSUE_13_NATIVE_PROVIDER_FAILURE" })
    } else {
      send(response)
      const textOnly = process.env.AML_PI_FIXTURE_MODE === "text-only"
      if (textOnly) {
        send({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: '{"proof":"completed work"}' },
        })
      }
      const message = {
        role: "assistant",
        content: textOnly ? [{ type: "text", text: '{"proof":"completed work"}' }] : [],
        stopReason: textOnly ? "stop" : "error",
        ...(!textOnly ? { errorMessage: "ISSUE_13_NATIVE_PROVIDER_FAILURE" } : {}),
        usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18 },
      }
      send({ type: "message_end", message })
      send({ type: "agent_end", messages: [message] })
      if (process.env.AML_PI_FIXTURE_MODE === "retry-exhausted") {
        send({ type: "auto_retry_end", success: false, attempt: 3, finalError: "ISSUE_13_NATIVE_PROVIDER_FAILURE" })
      }
      send({ type: "agent_settled" })
    }
  } else {
    send(response)
  }
}
