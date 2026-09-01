import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createServer, request } from "node:http"
import { z } from "zod"
import { describe, expect, it, vi } from "vitest"
import { execa } from "execa"

import { AcpMcpBridge, ACP_STRUCTURED_OUTPUT_TOOL_NAME } from "../src/components/agent/acp-mcp-bridge.js"
import { AcpMcpRelay } from "../src/components/agent/acp-mcp-relay.js"
import {
  agentStructuredOutputServices,
  attachAgentStructuredOutputServices,
} from "../src/components/agent/agent-structured-output-services.js"
import { spawnLocalProcess } from "../src/components/agent/spawn-local-process.js"
import { defineTool } from "../src/components/tool/define-tool.js"
import type { SandboxRuntime } from "../src/components/sandbox/sandbox-runtime.js"
import { createAgentExecutionContext } from "../src/testing/create-agent-execution-context.js"

describe("AcpMcpBridge", () => {
  it("shares structured-output services across SDK module copies", async () => {
    const context = createAgentExecutionContext()
    const services = {
      traceSubmission: vi.fn(),
      validate: vi.fn(async () => undefined),
    }

    attachAgentStructuredOutputServices(context, services)
    vi.resetModules()
    const secondCopy = await import("../src/components/agent/agent-structured-output-services.js")

    expect(agentStructuredOutputServices(context)).toBe(services)
    expect(secondCopy.agentStructuredOutputServices(context)).toBe(services)
  })

  it("serves JavaScript Tools and structured submission over authenticated MCP", async () => {
    const execute = vi.fn(async ({ value }: { value: string }) => ({
      echoed: value,
    }))
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
      context,
      {
        traceSubmission: () => undefined,
        validate: async value => {
          z.object({ proof: z.string() }).parse(value)
        },
      }
    )
    const connection = await bridge.start(context.signal)
    const client = await connectMcp(connection)

    try {
      expect(connection.name).toBe("tools")
      expect(connection.headers.Authorization).toMatch(/^Bearer [0-9a-f-]{36}$/u)
      expect(bridge.instruction).toContain("Call aml_submit_result once")
      expect(bridge.instruction).toContain("If the Tool returns an error, correct the result and retry")
      expect(bridge.instruction).toContain("After the Tool accepts a result, do not call it again")
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

  it("uses a compact numeric suffix when authored MCP server names collide", async () => {
    const context = createAgentExecutionContext()
    const bridge = new AcpMcpBridge([], undefined, context, undefined, ["tools", "tools_2", "unrelated"])
    const connection = await bridge.start(context.signal)

    try {
      expect(connection.name).toBe("tools_3")
    } finally {
      await bridge.close()
    }
  })

  it("accepts the first valid structured submission and traces later calls as ignored", async () => {
    const traceSubmission = vi.fn()
    const validateOutput = vi.fn(async (value: unknown) => {
      z.object({ proof: z.string() }).parse(value)
    })
    const context = createAgentExecutionContext()
    const bridge = new AcpMcpBridge(
      [],
      {
        jsonSchema: {
          additionalProperties: false,
          properties: { proof: { type: "string" } },
          required: ["proof"],
          type: "object",
        },
        type: "json",
      },
      context,
      { traceSubmission, validate: validateOutput }
    )
    const connection = await bridge.start(context.signal)
    const client = await connectMcp(connection)

    try {
      bridge.beginStructuredTurn()

      await expect(
        client.callTool({
          arguments: { result: { proof: 1 } },
          name: ACP_STRUCTURED_OUTPUT_TOOL_NAME,
        })
      ).resolves.toMatchObject({ isError: true })
      await expect(
        client.callTool({
          arguments: { result: { proof: "accepted" } },
          name: ACP_STRUCTURED_OUTPUT_TOOL_NAME,
        })
      ).resolves.not.toMatchObject({ isError: true })
      await expect(
        client.callTool({
          arguments: { result: { proof: "ignored" } },
          name: ACP_STRUCTURED_OUTPUT_TOOL_NAME,
        })
      ).resolves.toMatchObject({
        content: [{ text: expect.stringContaining("ignored") }],
      })

      expect(bridge.structuredResult()).toEqual({ proof: "accepted" })
      expect(validateOutput).toHaveBeenCalledTimes(2)
      expect(traceSubmission.mock.calls).toEqual([
        [1, "invalid", { proof: 1 }],
        [2, "accepted", { proof: "accepted" }],
        [3, "ignored", { result: { proof: "ignored" } }],
      ])
    } finally {
      await client.close()
      await bridge.close()
    }
  })

  it("serializes concurrent submissions so the first valid result wins", async () => {
    let releaseValidation: (() => void) | undefined
    const validationBlocked = new Promise<void>(resolve => {
      releaseValidation = resolve
    })
    const traceSubmission = vi.fn()
    const validate = vi.fn(async () => await validationBlocked)
    const context = createAgentExecutionContext()
    const bridge = new AcpMcpBridge(
      [],
      {
        jsonSchema: { type: "object" },
        type: "json",
      },
      context,
      { traceSubmission, validate }
    )
    const connection = await bridge.start(context.signal)
    const client = await connectMcp(connection)

    try {
      bridge.beginStructuredTurn()
      const first = client.callTool({
        arguments: { result: { proof: "first" } },
        name: ACP_STRUCTURED_OUTPUT_TOOL_NAME,
      })
      await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce())
      const second = client.callTool({
        arguments: { result: { proof: "second" } },
        name: ACP_STRUCTURED_OUTPUT_TOOL_NAME,
      })

      releaseValidation?.()
      await expect(Promise.all([first, second])).resolves.toHaveLength(2)

      expect(bridge.structuredResult()).toEqual({ proof: "first" })
      expect(validate).toHaveBeenCalledOnce()
      expect(traceSubmission.mock.calls).toEqual([
        [1, "accepted", { proof: "first" }],
        [2, "ignored", { result: { proof: "second" } }],
      ])
    } finally {
      await client.close()
      await bridge.close()
    }
  })

  it("recovers from a structured submission before the final authored turn", async () => {
    const traceSubmission = vi.fn()
    const context = createAgentExecutionContext()
    const bridge = new AcpMcpBridge(
      [],
      {
        jsonSchema: { type: "object" },
        type: "json",
      },
      context,
      { traceSubmission, validate: async () => undefined }
    )
    const connection = await bridge.start(context.signal)
    const client = await connectMcp(connection)

    try {
      await expect(
        client.callTool({
          arguments: { result: { proof: "early" } },
          name: ACP_STRUCTURED_OUTPUT_TOOL_NAME,
        })
      ).resolves.toMatchObject({ isError: true })

      bridge.beginStructuredTurn()
      await expect(
        client.callTool({
          arguments: { result: { proof: "accepted" } },
          name: ACP_STRUCTURED_OUTPUT_TOOL_NAME,
        })
      ).resolves.not.toMatchObject({ isError: true })

      expect(bridge.structuredResult()).toEqual({ proof: "accepted" })
      expect(traceSubmission.mock.calls).toEqual([
        [1, "invalid", { result: { proof: "early" } }],
        [2, "accepted", { proof: "accepted" }],
      ])
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

  it("does not let the Sandbox relay proxy requests to other host endpoints", async () => {
    let reached = false
    const target = createServer((_request, response) => {
      reached = true
      response.writeHead(204).end()
    })
    await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve))
    const address = target.address()
    if (address === null || typeof address === "string") throw new Error("Test target did not bind a TCP port")

    const context = createAgentExecutionContext()
    const bridge = new AcpMcpBridge([], undefined, context)
    const direct = await bridge.start(context.signal)
    const started = await AcpMcpRelay.start(localSandboxRuntime(), process.cwd(), direct, context.signal)

    try {
      const status = await requestAbsolute(started.connection.url, `http://127.0.0.1:${address.port}/private`)
      expect(status).toBe(502)
      expect(reached).toBe(false)
    } finally {
      await started.relay.close()
      await bridge.close()
      await new Promise<void>((resolve, reject) =>
        target.close(error => (error === undefined ? resolve() : reject(error)))
      )
    }
  })

  it("rejects a missing local executable without an unhandled process error", async () => {
    const signal = new AbortController().signal
    await expect(
      spawnLocalProcess(`aml-missing-executable-${Date.now()}`, [], {
        cwd: process.cwd(),
        signal,
      })
    ).rejects.toMatchObject({ code: "ENOENT" })
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
    async createFileStaging() {
      throw new Error("file staging is not used by this ACP relay fixture")
    },
    cwd: process.cwd(),
    async exec(command, args, options) {
      const result = await execa(command, args ?? [], {
        cwd: options?.cwd ?? process.cwd(),
        ...(options?.env === undefined ? {} : { env: options.env }),
        reject: false,
        ...(options?.signal === undefined ? {} : { cancelSignal: options.signal }),
      })
      return {
        exitCode: result.exitCode ?? 1,
        stderr: result.stderr,
        stdout: result.stdout,
      }
    },
    async readFile() {
      throw new Error("filesystem reads are not used by this ACP relay fixture")
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
    async stat() {
      throw new Error("filesystem metadata is not used by this ACP relay fixture")
    },
    async writeFile() {
      throw new Error("filesystem writes are not used by this ACP relay fixture")
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

async function requestAbsolute(relayUrl: string, targetUrl: string): Promise<number | undefined> {
  const relay = new URL(relayUrl)

  return await new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: relay.hostname,
        method: "POST",
        path: targetUrl,
        port: relay.port,
      },
      response => {
        response.resume()
        response.once("end", () => resolve(response.statusCode))
      }
    )
    outgoing.once("error", reject)
    outgoing.end("{}")
  })
}
