import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type {
  SandboxAcquireRequest,
  SandboxExecOptions,
  SandboxExecResult,
  WorkspaceMaterializationReference,
} from "@aml-jsx/sdk"
import { sandboxProviderConformance } from "@aml-jsx/sdk/testing"

import { dockerSandbox } from "../src/index.js"
import { createDockerSandboxProvider } from "../src/docker-sandbox.js"

interface RunnerCall {
  readonly args: readonly string[]
  readonly command: string
  readonly options: Readonly<SandboxExecOptions & { maxOutputBytes: number }>
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async directory => await rm(directory, { force: true, recursive: true }))
  )
})

describe("dockerSandbox()", () => {
  it("starts only a named image and attaches the selected Workspace", async () => {
    const workspace = await createWorkspace()
    const runner = new FakeRunner()
    const provider = createDockerSandboxProvider(
      {
        image: "node:26-alpine",
        workspace,
      },
      runner
    )
    const lease = await provider.acquire(request({ access: "read-only", cwd: "repository/src" }))

    expect(runner.calls[0]).toMatchObject({
      command: "docker",
      args: [
        "run",
        "--detach",
        "--rm",
        "--name",
        expect.stringMatching(/^aml-docker-test-/),
        "--volume",
        `${path.join(workspace, "repository")}:/workspace:ro`,
        "--workdir",
        "/workspace/src",
        "--entrypoint",
        "sh",
        "node:26-alpine",
        "-c",
        expect.any(String),
      ],
    })
    expect(lease.handle).toEqual({
      containerId: "container-123",
      kind: "docker",
    })
    expect(lease.runtime).toMatchObject({
      access: "read-only",
      cwd: "repository/src",
      root: "repository",
    })

    await lease.release()
    expect(runner.calls.at(-1)?.args).toEqual(["rm", "--force", "container-123"])
  })

  it("uses the common runtime for literal commands, cwd, and environment", async () => {
    const workspace = await createWorkspace()
    const runner = new FakeRunner({
      exec: {
        exitCode: 7,
        stderr: "warning",
        stdout: "result",
      },
    })
    const lease = await createDockerSandboxProvider({ image: "agent-image", workspace }, runner).acquire(request())
    const result = await lease.runtime.exec("node", ["agent.mjs", "hello; literal"], {
      cwd: "repository/src",
      env: { API_KEY: "configured" },
      timeoutMs: 5000,
    })

    expect(result).toEqual({
      exitCode: 7,
      stderr: "warning",
      stdout: "result",
    })
    expect(runner.calls.at(-1)).toMatchObject({
      command: "docker",
      args: [
        "exec",
        "--workdir",
        "/workspace/src",
        "--env",
        "API_KEY=configured",
        "container-123",
        "node",
        "agent.mjs",
        "hello; literal",
      ],
      options: {
        maxOutputBytes: 4 * 1024 * 1024,
        timeoutMs: 5000,
      },
    })
  })

  it("runs setup before returning and removes a failed setup container", async () => {
    const workspace = await createWorkspace()
    const success = new FakeRunner()
    await createDockerSandboxProvider(
      {
        image: "agent-image",
        setup: "npm install -g <agent-package>",
        workspace,
      },
      success
    ).acquire(request())

    expect(success.calls[1]?.args).toEqual([
      "exec",
      "--workdir",
      "/workspace",
      "container-123",
      "sh",
      "-lc",
      "npm install -g <agent-package>",
    ])

    const failure = new FakeRunner({
      exec: {
        exitCode: 9,
        stderr: "install failed",
        stdout: "",
      },
    })
    await expect(
      createDockerSandboxProvider(
        {
          image: "agent-image",
          setup: "install agent",
          workspace,
        },
        failure
      ).acquire(request())
    ).rejects.toThrow("setup failed with exit code 9: install failed")
    expect(failure.calls.at(-1)?.args).toEqual(["rm", "--force", "container-123"])
  })

  it("prefers an active Workspace and confines effective cwd", async () => {
    const fallback = await createWorkspace()
    const active = await createWorkspace()
    const runner = new FakeRunner()
    const workspace: WorkspaceMaterializationReference = Object.freeze({
      cwd: ".",
      directory: active,
      handle: {},
      leaseId: "workspace-lease",
      provider: { name: "local" },
      workspaceId: "workspace",
      writeConcurrency: "serial",
    })
    const lease = await createDockerSandboxProvider({ image: "agent-image", workspace: fallback }, runner).acquire(
      request({ workspace })
    )

    expect(runner.calls[0]?.args).toContain(`${path.join(active, "repository")}:/workspace`)
    await expect(lease.runtime.exec("pwd", [], { cwd: "outside" })).rejects.toThrow(
      "Sandbox command cwd resolves outside its configured root"
    )
  })

  it("validates the image-first configuration without running Docker", () => {
    expect(() => dockerSandbox({ image: "" })).toThrow("image must be a non-empty normalized string")
    expect(() => dockerSandbox({ image: " alpine " })).toThrow("image must be a non-empty normalized string")
    expect(() => dockerSandbox({ image: "alpine", maxOutputBytes: 0 })).toThrow(
      "maxOutputBytes must be a positive safe integer"
    )
    expect(() => dockerSandbox({ image: "alpine", setup: " setup " })).toThrow(
      "setup must be a non-empty normalized string"
    )
  })

  it("passes provider conformance with a fake Docker CLI", async () => {
    const workspace = await createWorkspace()

    await expect(
      sandboxProviderConformance(createDockerSandboxProvider({ image: "agent-image", workspace }, new FakeRunner()))
    ).resolves.toBeUndefined()
  })
})

class FakeRunner {
  readonly calls: RunnerCall[] = []
  readonly #exec: Readonly<SandboxExecResult>

  constructor(options: { readonly exec?: Readonly<SandboxExecResult> } = {}) {
    this.#exec = options.exec ?? { exitCode: 0, stderr: "", stdout: "" }
  }

  async run(
    command: string,
    args: readonly string[],
    options: Readonly<SandboxExecOptions & { maxOutputBytes: number }>
  ): Promise<Readonly<SandboxExecResult>> {
    this.calls.push({
      args: [...args],
      command,
      options: { ...options },
    })

    if (args[0] === "run") {
      return { exitCode: 0, stderr: "", stdout: "container-123\n" }
    }

    if (args[0] === "rm") {
      return { exitCode: 0, stderr: "", stdout: "" }
    }

    return this.#exec
  }
}

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "aml-docker-sandbox-"))
  temporaryDirectories.push(workspace)
  await mkdir(path.join(workspace, "repository", "src"), { recursive: true })
  await writeFile(path.join(workspace, "repository", "fixture.txt"), "fixture")
  return workspace
}

function request(overrides: Partial<SandboxAcquireRequest> = {}): SandboxAcquireRequest {
  return Object.freeze({
    access: "read-write",
    cwd: "repository",
    evaluationId: "docker-test",
    root: "repository",
    signal: new AbortController().signal,
    ...overrides,
  })
}
