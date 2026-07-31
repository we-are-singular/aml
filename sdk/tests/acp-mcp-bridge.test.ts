import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { z } from "zod"
import { describe, expect, it, vi } from "vitest"
import { execa } from "execa"

import { AcpMcpBridge, ACP_STRUCTURED_OUTPUT_TOOL_NAME } from "../src/components/agent/acp-mcp-bridge.js"
import { AcpMcpRelay } from "../src/components/agent/acp-mcp-relay.js"
import { spawnLocalProcess } from "../src/components/agent/spawn-local-process.js"
import { defineTool } from "../src/components/tool/define-tool.js"
import type { SandboxRuntime } from "../src/components/sandbox/sandbox-runtime.js"
import { createAgentExecutionContext } from "../src/testing/create-agent-execution-context.js"

describe("AcpMcpBridge", () => {
  it("serves JavaScript Tools and structured submission over authenticated MCP", async () => {
    const execute = vi.fn(async ({ value }: { value: string }) => ({ echoed: value }))
    const tool = defineTool({
      description: "Echo one fixture value",
      input: z.object({ value: z.string() }),
      name: "echo_fixture",
      execute,
    })
    const context = createAgentExecutionContext()
    const bridge = new AcpMcpBridge(
      [tool],
      {
        jsonSchema: {
          additionalProperties: false,
          properties: { proof: { type: "string" } },
          required: ["proof"],
          type: "object",
        },
        type: "json",
      },
      context
    )
    const connection = await bridge.start(context.signal)
    const client = await connectMcp(connection)

    try {
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [{ name: "echo_fixture" }, { name: ACP_STRUCTURED_OUTPUT_TOOL_NAME }],
      })
      await expect(
        client.callTool({
          arguments: { value: "ready" },
          name: "echo_fixture",
        })
      ).resolves.toMatchObject({
        content: [{ text: '{"echoed":"ready"}', type: "text" }],
      })

      bridge.beginStructuredTurn()
      await client.callTool({
        arguments: { result: { proof: "accepted" } },
        name: ACP_STRUCTURED_OUTPUT_TOOL_NAME,
      })
      expect(bridge.structuredResult()).toEqual({ proof: "accepted" })
      expect(execute).toHaveBeenCalledOnce()
    } finally {
      await client.close()
      await bridge.close()
    }
  })

  it("forwards the same MCP endpoint through a spawned Sandbox relay", async () => {
    const tool = defineTool({
      description: "Return the relay fixture",
      input: z.object({}),
      name: "relay_fixture",
      async execute() {
        return "relayed"
      },
    })
    const context = createAgentExecutionContext()
    const bridge = new AcpMcpBridge([tool], undefined, context)
    const direct = await bridge.start(context.signal)
    const runtime = localSandboxRuntime()
    const started = await AcpMcpRelay.start(runtime, process.cwd(), direct, context.signal)
    const client = await connectMcp(started.connection)

    try {
      await expect(
        client.callTool({
          arguments: {},
          name: "relay_fixture",
        })
      ).resolves.toMatchObject({
        content: [{ text: "relayed", type: "text" }],
      })
    } finally {
      await client.close()
      await started.relay.close()
      await bridge.close()
    }
  })

  it("streams long-lived HTTP responses through the Sandbox relay", async () => {
    let releaseResponse!: () => void
    const finishResponse = new Promise<void>(resolve => (releaseResponse = resolve))
    const host = createServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write("event: first\ndata: ready\n\n")
      await finishResponse
      response.end("event: second\ndata: done\n\n")
    })
    await new Promise<void>((resolve, reject) => {
      host.once("error", reject)
      host.listen(0, "127.0.0.1", resolve)
    })
    const address = host.address()
    if (address === null || typeof address === "string") throw new Error("Fixture HTTP server has no TCP address")

    const context = createAgentExecutionContext()
    const started = await AcpMcpRelay.start(
      localSandboxRuntime(),
      process.cwd(),
      { headers: {}, name: "stream-fixture", url: `http://127.0.0.1:${address.port}/mcp` },
      context.signal
    )

    try {
      const response = await fetch(started.connection.url)
      const reader = response.body?.getReader()
      if (reader === undefined) throw new Error("Relay fixture response has no body")

      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain("event: first")
      releaseResponse()

      let remainder = ""
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        remainder += new TextDecoder().decode(chunk.value)
      }
      expect(remainder).toContain("event: second")
    } finally {
      releaseResponse()
      await started.relay.close()
      await new Promise<void>((resolve, reject) =>
        host.close(error => (error === undefined ? resolve() : reject(error)))
      )
    }
  })

  it("accepts a fresh client after an MCP capability probe disconnects", async () => {
    const tool = defineTool({
      description: "Return the reconnect fixture",
      input: z.object({}),
      name: "reconnect_fixture",
      async execute() {
        return "connected"
      },
    })
    const context = createAgentExecutionContext()
    const bridge = new AcpMcpBridge([tool], undefined, context)
    const connection = await bridge.start(context.signal)
    const probe = await connectMcp(connection)
    await probe.close()
    const client = await connectMcp(connection)

    try {
      await expect(client.callTool({ arguments: {}, name: "reconnect_fixture" })).resolves.toMatchObject({
        content: [{ text: "connected", type: "text" }],
      })
    } finally {
      await client.close()
      await bridge.close()
    }
  })
})

function localSandboxRuntime(): SandboxRuntime {
  return {
    access: "read-write",
    cwd: process.cwd(),
    async exec(command, args, options) {
      const result = await execa(command, args ?? [], {
        cwd: options?.cwd ?? process.cwd(),
        ...(options?.env === undefined ? {} : { env: options.env }),
        reject: false,
        ...(options?.signal === undefined ? {} : { cancelSignal: options.signal }),
      })
      return { exitCode: result.exitCode ?? 1, stderr: result.stderr, stdout: result.stdout }
    },
    root: process.cwd(),
    async spawn(command, args, options) {
      return await spawnLocalProcess(command, args ?? [], {
        cwd: options?.cwd ?? process.cwd(),
        ...(options?.env === undefined ? {} : { env: options.env }),
        signal: options?.signal ?? new AbortController().signal,
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
    },
  }
}

async function connectMcp(connection: {
  readonly headers: Readonly<Record<string, string>>
  readonly url: string
}): Promise<McpClient> {
  const client = new McpClient({ name: "aml-test", version: "0.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: connection.headers },
  })
  await client.connect(transport as never)
  return client
}
import { createServer } from "node:http"
