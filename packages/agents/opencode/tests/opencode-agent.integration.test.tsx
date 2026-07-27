import { randomUUID } from "node:crypto"

import {
  Agent,
  AmlRuntime,
  defineMcpServer,
  defineTool,
  evaluate,
  FollowUp,
  Mcp,
  Tool,
} from "@aml/sdk"
import { expect, it } from "vitest"
import { z } from "zod"

import { opencodeAgent } from "../src/index.js"
import { OpenCodeToolBridge } from "../src/opencode-tool-bridge.js"

const liveTest =
  process.env.AML_OPENCODE_LIVE === "1" ? it : it.skip

liveTest(
  "retains conversation history across real OpenCode FollowUps",
  async () => {
    const secret = randomUUID()
    const provider = opencodeAgent({
      model:
        process.env.AML_OPENCODE_MODEL ?? "opencode-go/minimax-m3",
      server: { port: 0, timeout: 15_000 },
    })

    try {
      const output = await new AmlRuntime({
        agentProvider: provider,
      }).evaluate(
        <Agent>
          Remember the exact token "{secret}". Reply only with acknowledged.
          <FollowUp>
            Return only the exact token from the preceding message.
          </FollowUp>
        </Agent>,
      )

      expect(output.trim()).toBe(secret)
    } finally {
      await provider.close()
    }
  },
  120_000,
)

liveTest(
  "runs one credentialed opencode-go Agent with a JavaScript Tool",
  async () => {
    const expectedLabel = "javascript-tool-ready"
    let calls = 0
    const lookupLabel = defineTool({
      description: "Look up the current JavaScript Tool fixture label",
      input: z.object({}),
      name: "lookup_aml_fixture_label",
      async execute() {
        calls += 1
        return expectedLabel
      },
    })
    const provider = opencodeAgent({
      model:
        process.env.AML_OPENCODE_MODEL ?? "opencode-go/minimax-m3",
      server: { port: 0, timeout: 15_000 },
    })

    try {
      const output = await new AmlRuntime({
        agentProvider: provider,
      }).evaluate(
        <Agent>
          <Tool use={lookupLabel} />
          Use lookup_aml_fixture_label to read the current integration
          fixture label. Return only that label.
        </Agent>,
      )

      expect(output.trim()).toBe(expectedLabel)
      expect(calls).toBe(1)
    } finally {
      await provider.close()
    }
  },
  120_000,
)

liveTest(
  "returns schema-validated structured output from a real OpenCode Agent",
  async () => {
    const secret = randomUUID()
    const Result = z.object({
      count: z.number().int(),
      proof: z.string(),
    })
    const provider = opencodeAgent({
      model:
        process.env.AML_OPENCODE_MODEL ?? "opencode-go/minimax-m3",
      server: { port: 0, timeout: 15_000 },
    })

    async function StructuredProof() {
      const result = await evaluate(
        <Agent>
          Return proof "{secret}" and count 7 as the requested structured
          result.
        </Agent>,
        Result,
      )

      return `${result.proof}:${result.count}`
    }

    try {
      await expect(
        new AmlRuntime({ agentProvider: provider }).evaluate(
          <StructuredProof />,
        ),
      ).resolves.toBe(`${secret}:7`)
    } finally {
      await provider.close()
    }
  },
  120_000,
)

liveTest(
  "attaches a configured Streamable HTTP MCP server to a real OpenCode Agent",
  async () => {
    const expectedLabel = "configured-mcp-ready"
    let calls = 0
    const controller = new AbortController()
    const lookupLabel = defineTool({
      description: "Look up the current AML integration fixture label",
      input: z.object({}),
      name: "lookup_configured_mcp_label",
      async execute() {
        calls += 1
        return expectedLabel
      },
    })
    // This application-owned bridge behaves as an ordinary remote MCP server.
    // The Agent receives only its portable <Mcp> descriptor, not the AML Tool.
    const bridge = new OpenCodeToolBridge(
      [lookupLabel],
      Object.freeze({
        signal: controller.signal,
        trace: Object.freeze({
          runId: "mcp-live",
          spanId: "mcp-live-1",
        }),
      }),
    )
    const connection = await bridge.start(controller.signal)
    const server = defineMcpServer({
      name: "aml-proof",
      transport: {
        headers: connection.headers,
        type: "streamable-http",
        url: connection.url,
      },
    })
    const provider = opencodeAgent({
      model:
        process.env.AML_OPENCODE_MODEL ?? "opencode-go/minimax-m3",
      server: { port: 0, timeout: 15_000 },
    })

    try {
      const output = await new AmlRuntime({
        agentProvider: provider,
      }).evaluate(
        <Agent>
          <Mcp use={server} />
          Use the lookup_configured_mcp_label tool from the aml-proof MCP
          server to read the current integration fixture label. Return only
          that label.
        </Agent>,
      )

      expect(output.trim()).toBe(expectedLabel)
      expect(calls).toBe(1)
    } finally {
      // The OpenCode adapter owns its MCP client connection; the application
      // still owns and explicitly closes the remote server endpoint itself.
      await provider.close()
      await bridge.close()
    }
  },
  120_000,
)
