import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { SandboxAcquireRequest } from "@aml-jsx/sdk"

import { modalSandbox } from "../src/index.js"

const enabled = process.env.AML_MODAL_TEST === "1"
const describeIntegration = enabled ? describe : describe.skip
let directory: string

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../../../.env"))
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error
  }
}

describeIntegration("Modal Sandbox integration", () => {
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "aml-modal-integration-"))
    await writeFile(path.join(directory, "input.txt"), "from-host")
  })

  afterAll(async () => {
    await rm(directory, { force: true, recursive: true })
  })

  it("executes remotely and reconciles Workspace changes", async () => {
    const tokenId = process.env.MODAL_API_KEY
    const tokenSecret = process.env.MODAL_API_SECRET

    if (tokenId === undefined || tokenSecret === undefined) {
      throw new Error("Modal integration requires MODAL_API_KEY and MODAL_API_SECRET")
    }

    const provider = modalSandbox({
      appName: "aml-jsx-integration",
      config: { tokenId, tokenSecret },
      create: { timeoutMs: 120_000 },
      image: "alpine:3.22",
      setup: 'test "$(cat input.txt)" = "from-host"',
      workspace: directory,
    })
    const request: SandboxAcquireRequest = Object.freeze({
      access: "read-write",
      cwd: ".",
      evaluationId: "modal-integration",
      root: ".",
      signal: new AbortController().signal,
    })
    const lease = await provider.acquire(request)

    try {
      await expect(
        lease.runtime.exec("sh", ["-lc", "printf %s from-modal > output.txt && cat output.txt"])
      ).resolves.toEqual({
        exitCode: 0,
        stderr: "",
        stdout: "from-modal",
      })
    } finally {
      await lease.release()
    }

    await expect(readFile(path.join(directory, "output.txt"), "utf8")).resolves.toBe("from-modal")
  }, 180_000)
})
