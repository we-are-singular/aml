import { randomUUID } from "node:crypto"

import {
  Agent,
  AmlRuntime,
  defineMcpServer,
  defineTool,
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
  "runs one credentialed opencode-go Agent with a JavaScript Tool",
  async () => {
    const secret = randomUUID()
    let calls = 0
    const revealProof = defineTool({
      description: "Return the private AML integration proof value",
      input: z.object({}),
      name: "reveal_aml_proof",
      async execute() {
        calls += 1
        return secret
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
          <Tool use={revealProof} />
          Call the reveal_aml_proof tool. Reply with exactly the value
          returned by the tool and no other text.
        </Agent>,
      )

      expect(output.trim()).toBe(secret)
      expect(calls).toBe(1)
    } finally {
      await provider.close()
    }
  },
  120_000,
)

liveTest(
  "attaches a configured Streamable HTTP MCP server to a real OpenCode Agent",
  async () => {
    const secret = randomUUID()
    let calls = 0
    const controller = new AbortController()
    const revealProof = defineTool({
      description: "Return the private configured-MCP proof value",
      input: z.object({}),
      name: "reveal_configured_mcp_proof",
      async execute() {
        calls += 1
        return secret
      },
    })
    // This application-owned bridge behaves as an ordinary remote MCP server.
    // The Agent receives only its portable <Mcp> descriptor, not the AML Tool.
    const bridge = new OpenCodeToolBridge(
      [revealProof],
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
          Call the reveal_configured_mcp_proof tool from the aml-proof MCP
          server. Reply with exactly the value returned by the tool and no
          other text.
        </Agent>,
      )

      expect(output.trim()).toBe(secret)
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
