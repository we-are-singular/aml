import { cp, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Agent, AmlRuntime } from "@aml-jsx/sdk"
import { expect, it } from "vitest"

import { codexAgent } from "../src/index.js"

const liveTest = process.env.AML_CODEX_ACP_LIVE === "1" ? it : it.skip

liveTest(
  "runs Codex through the published ACP adapter on the trusted local launcher",
  async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "aml-codex-acp-"))
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "aml-codex-acp-home-"))
    await cp(path.join(os.homedir(), ".codex", "auth.json"), path.join(codexHome, "auth.json"))
    const provider = codexAgent({
      args: ["-y", "@agentclientprotocol/codex-acp@1.1.7"],
      command: "npx",
      env: { CODEX_HOME: codexHome },
      workingDirectory: workspace,
    })

    try {
      const output = await new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>Reply with exactly: Hello from ACP</Agent>
      )

      expect(output.trim()).toBe("Hello from ACP")
    } finally {
      await Promise.all([
        rm(workspace, { force: true, recursive: true }),
        rm(codexHome, { force: true, recursive: true }),
      ])
    }
  },
  180_000
)
