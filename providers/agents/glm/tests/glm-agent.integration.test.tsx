import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Agent, AmlRuntime } from "@aml-jsx/sdk"
import { expect, it } from "vitest"

import { glmAgent } from "../src/index.js"

const liveTest = process.env.AML_GLM_ACP_LIVE === "1" ? it : it.skip

liveTest(
  "runs GLM through the published ACP adapter on the trusted local launcher",
  async () => {
    const apiKey = process.env.Z_AI_API_KEY
    if (apiKey === undefined) throw new Error("GLM live test requires Z_AI_API_KEY")

    const workspace = await mkdtemp(path.join(os.tmpdir(), "aml-glm-acp-"))
    const provider = glmAgent({
      apiKey,
      args: ["-y", "glm-acp-agent@1.5.0"],
      command: "npx",
      workingDirectory: workspace,
    })

    try {
      const output = await new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>Reply with exactly: Hello from ACP</Agent>
      )

      expect(output.trim()).toBe("Hello from ACP")
    } finally {
      await rm(workspace, { force: true, recursive: true })
    }
  },
  180_000
)
