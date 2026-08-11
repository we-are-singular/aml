import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Agent, AmlRuntime } from "@aml-jsx/sdk"
import { expect, it } from "vitest"

import { copilotAgent } from "../src/index.js"

const liveTest = process.env.AML_COPILOT_LIVE === "1" ? it : it.skip

liveTest(
  "runs GitHub Copilot through its native ACP server with explicit authentication",
  async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "aml-copilot-acp-"))
    const githubToken =
      process.env.AML_COPILOT_GITHUB_TOKEN ??
      process.env.COPILOT_GITHUB_TOKEN ??
      process.env.GH_TOKEN ??
      process.env.GITHUB_TOKEN
    if (githubToken === undefined) {
      throw new Error(
        "Copilot integration test requires COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN; AML_COPILOT_GITHUB_TOKEN may override them"
      )
    }

    const provider = copilotAgent({
      env: { COPILOT_GITHUB_TOKEN: githubToken },
      model: process.env.AML_COPILOT_MODEL ?? "gpt-5-mini",
      workingDirectory: workspace,
    })

    try {
      const output = await new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>Reply with exactly: Hello from Copilot ACP</Agent>
      )

      expect(output.trim()).toBe("Hello from Copilot ACP")
    } finally {
      await rm(workspace, { force: true, recursive: true })
    }
  },
  180_000
)
