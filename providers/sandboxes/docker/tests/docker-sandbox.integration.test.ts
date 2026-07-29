import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { dockerSandbox } from "../src/index.js"

const dockerEnabled = process.env.AML_DOCKER_TEST === "1"

describe.skipIf(!dockerEnabled)("Docker Sandbox integration", () => {
  it("executes in and persists a writable mounted Workspace", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "aml-docker-integration-"))
    await mkdir(path.join(workspace, "repository"), { recursive: true })
    await writeFile(path.join(workspace, "repository", "input.txt"), "hello docker")
    const provider = dockerSandbox({
      image: process.env.AML_DOCKER_IMAGE ?? "alpine:3.22",
      setup: "printf setup > setup.txt",
      workspace,
    })
    const lease = await provider.acquire({
      access: "read-write",
      cwd: "repository",
      evaluationId: "docker-integration",
      root: "repository",
      signal: new AbortController().signal,
    })

    try {
      const result = await lease.runtime.exec("sh", [
        "-lc",
        "value=$(cat input.txt); printf '%s' \"$value written\" > output.txt",
      ])

      expect(result).toMatchObject({ exitCode: 0, stderr: "" })
      await expect(readFile(path.join(workspace, "repository", "setup.txt"), "utf8")).resolves.toBe("setup")
      await expect(readFile(path.join(workspace, "repository", "output.txt"), "utf8")).resolves.toBe(
        "hello docker written"
      )
    } finally {
      await lease.release()
      await rm(workspace, { force: true, recursive: true })
    }
  }, 120_000)
})
