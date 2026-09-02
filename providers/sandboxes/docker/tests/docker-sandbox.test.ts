import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type {
  SandboxAcquireRequest,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxProcess,
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
        "wearesingular/aml-agent-sandbox:latest",
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

  it("starts the container as an explicitly selected runtime user", async () => {
    const workspace = await createWorkspace()
    const runner = new FakeRunner()
    const lease = await createDockerSandboxProvider(
      { image: "agent-image", user: "1002:1002", workspace },
      runner
    ).acquire(request())

    expect(runner.calls[0]?.args).toEqual(
      expect.arrayContaining(["--user", "1002:1002", "--volume", `${path.join(workspace, "repository")}:/workspace`])
    )
    await lease.release()
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

  it("preserves startup and cleanup failures together", async () => {
    const workspace = await createWorkspace()
    const runner = new FakeRunner({
      remove: { exitCode: 1, stderr: "", stdout: "docker unavailable" },
      run: { exitCode: 1, stderr: "", stdout: "docker unavailable" },
    })

    const acquisition = createDockerSandboxProvider({ image: "agent-image", workspace }, runner).acquire(request())
    await expect(acquisition).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'Docker Sandbox failed to start image "agent-image": docker unavailable' }),
        expect.objectContaining({ message: "Docker Sandbox cleanup failed: docker unavailable" }),
      ],
      message: "Docker Sandbox startup and cleanup failed",
    })
  })

  it("spawns literal commands through a remote process-group wrapper", async () => {
    const workspace = await createWorkspace()
    const runner = new FakeRunner()
    const lease = await createDockerSandboxProvider({ image: "agent-image", workspace }, runner).acquire(request())
    const process = await lease.runtime.spawn("node", ["agent.mjs", "hello; literal"], {
      cwd: "repository/src",
      env: { API_KEY: "configured" },
    })

    expect(process.id).toBe("fake-process")
    expect(runner.spawnCalls).toHaveLength(1)
    expect(runner.spawnCalls[0]).toMatchObject({
      args: [
        "exec",
        "--interactive",
        "--workdir",
        "/workspace/src",
        "--env",
        "API_KEY=configured",
        "container-123",
        "sh",
        "-c",
        expect.stringContaining('exec "$@"'),
        "aml-spawn",
        "node",
        "agent.mjs",
        "hello; literal",
      ],
      command: "docker",
    })
  })

  it("reads, writes, and cleans up complete files through the Docker filesystem boundary", async () => {
    const workspace = await createWorkspace()
    const runner = new FilesystemFakeRunner()
    const lease = await createDockerSandboxProvider({ image: "agent-image", workspace }, runner).acquire(request())

    await expect(lease.runtime.stat("repository/fixture.txt")).resolves.toEqual({
      kind: "file",
      modifiedAtMs: 1_000,
      size: 7,
    })
    await expect(lease.runtime.readFile("repository/fixture.txt")).resolves.toEqual(new TextEncoder().encode("fixture"))

    await lease.runtime.writeFile("repository/generated/result.txt", new TextEncoder().encode("generated"))
    await expect(lease.runtime.readFile("repository/generated/result.txt")).resolves.toEqual(
      new TextEncoder().encode("generated")
    )

    const staging = await lease.runtime.createFileStaging()
    await staging.writeFile(".agents/skills/evidence/SKILL.md", new TextEncoder().encode("skill"))
    expect(runner.readGuestFile(`${staging.root}/.agents/skills/evidence/SKILL.md`)).toBe("skill")
    await staging.release()
    await staging.release()
    expect(runner.hasGuestPath(staging.root)).toBe(false)

    await lease.release()
  })

  it("omits an unparseable guest modification time without failing stat", async () => {
    const workspace = await createWorkspace()
    const runner = new FilesystemFakeRunner("not-a-date")
    const lease = await createDockerSandboxProvider({ image: "agent-image", workspace }, runner).acquire(request())

    await expect(lease.runtime.stat("repository/fixture.txt")).resolves.toEqual({ kind: "file", size: 7 })
    await lease.release()
  })

  it("keeps Agent staging writable while rejecting Workspace writes in a read-only Docker Sandbox", async () => {
    const workspace = await createWorkspace()
    const runner = new FilesystemFakeRunner()
    const lease = await createDockerSandboxProvider({ image: "agent-image", workspace }, runner).acquire(
      request({ access: "read-only" })
    )

    await expect(
      lease.runtime.writeFile("repository/generated.txt", new TextEncoder().encode("generated"))
    ).rejects.toThrow("Docker Sandbox filesystem is read-only")

    const staging = await lease.runtime.createFileStaging()
    await staging.writeFile(".agents/skills/evidence/SKILL.md", new TextEncoder().encode("skill"))
    expect(runner.readGuestFile(`${staging.root}/.agents/skills/evidence/SKILL.md`)).toBe("skill")
    await staging.release()
    await lease.release()
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
    expect(() => dockerSandbox()).not.toThrow()
    expect(() => dockerSandbox({ image: "" })).toThrow("image must be a non-empty normalized string")
    expect(() => dockerSandbox({ image: " alpine " })).toThrow("image must be a non-empty normalized string")
    expect(() => dockerSandbox({ image: "alpine", maxOutputBytes: 0 })).toThrow(
      "maxOutputBytes must be a positive safe integer"
    )
    expect(() => dockerSandbox({ image: "alpine", setup: " setup " })).toThrow(
      "setup must be a non-empty normalized string"
    )
    expect(() => dockerSandbox({ image: "alpine", user: " 1000:1000" })).toThrow(
      "user must be a non-empty normalized string"
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
  readonly spawnCalls: Array<{ readonly args: readonly string[]; readonly command: string }> = []
  readonly #exec: Readonly<SandboxExecResult>
  readonly #remove: Readonly<SandboxExecResult>
  readonly #run: Readonly<SandboxExecResult>

  constructor(
    options: {
      readonly exec?: Readonly<SandboxExecResult>
      readonly remove?: Readonly<SandboxExecResult>
      readonly run?: Readonly<SandboxExecResult>
    } = {}
  ) {
    this.#exec = options.exec ?? { exitCode: 0, stderr: "", stdout: "" }
    this.#remove = options.remove ?? { exitCode: 0, stderr: "", stdout: "" }
    this.#run = options.run ?? { exitCode: 0, stderr: "", stdout: "container-123\n" }
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
      return this.#run
    }

    if (args[0] === "rm") {
      return this.#remove
    }

    return this.#exec
  }

  async spawn(
    command: string,
    args: readonly string[],
    _options: Readonly<SandboxExecOptions>,
    _killRemote: () => Promise<void>
  ): Promise<Readonly<SandboxProcess>> {
    this.spawnCalls.push({ args: [...args], command })
    return {
      id: "fake-process",
      async kill() {},
      stdin: new WritableStream(),
      stderr: emptyStream(),
      stdout: emptyStream(),
      async wait() {
        return { exitCode: 0 }
      },
    }
  }
}

class FilesystemFakeRunner {
  readonly #files = new Map<string, Uint8Array>([["/workspace/fixture.txt", new TextEncoder().encode("fixture")]])

  constructor(readonly modifiedAtValue = "1970-01-01 00:00:01.000000000 +0000") {}

  hasGuestPath(candidate: string): boolean {
    return [...this.#files].some(([filePath]) => filePath === candidate || filePath.startsWith(`${candidate}/`))
  }

  readGuestFile(filePath: string): string | undefined {
    const content = this.#files.get(filePath)
    return content === undefined ? undefined : new TextDecoder().decode(content)
  }

  async run(
    _command: string,
    args: readonly string[],
    _options: Readonly<SandboxExecOptions & { maxOutputBytes: number }>
  ): Promise<Readonly<SandboxExecResult>> {
    if (args[0] === "run") {
      return result("container-123\n")
    }

    if (args[0] === "rm" && args[1] === "--force") {
      return result()
    }

    if (args[0] === "cp") {
      const source = args[1]
      const destination = args[2]

      if (source === undefined || destination === undefined) {
        return result("", "invalid copy", 1)
      }

      if (source.startsWith("container-123:")) {
        const content = this.#files.get(source.slice("container-123:".length))

        if (content === undefined) {
          return result("", "missing guest file", 1)
        }

        await writeFile(destination, content)
        return result()
      }

      this.#files.set(destination.slice("container-123:".length), Uint8Array.from(await readFile(source)))
      return result()
    }

    if (args[0] !== "exec") {
      return result()
    }

    const command = args[2]

    if (command === "stat") {
      const filePath = args.at(-1)
      const content = filePath === undefined ? undefined : this.#files.get(filePath)

      if (content !== undefined) {
        return result(`81a4\t${content.byteLength}\t${this.modifiedAtValue}\n`)
      }

      if (filePath !== undefined && this.#isDirectory(filePath)) {
        return result(`41ed\t0\t${this.modifiedAtValue}\n`)
      }

      return result("", "missing", 1)
    }

    if (command === "realpath") {
      return result(`${args.at(-1)}\n`)
    }

    if (command === "mv") {
      const source = args.at(-2)
      const destination = args.at(-1)
      const content = source === undefined ? undefined : this.#files.get(source)

      if (source === undefined || content === undefined || destination === undefined) {
        return result("", "missing temporary file", 1)
      }

      this.#files.delete(source)
      this.#files.set(destination, content)
      return result()
    }

    if (command === "rm") {
      const target = args.at(-1)

      if (target !== undefined) {
        for (const filePath of this.#files.keys()) {
          if (filePath === target || filePath.startsWith(`${target}/`)) {
            this.#files.delete(filePath)
          }
        }
      }
    }

    return result()
  }

  #isDirectory(candidate: string): boolean {
    return candidate === "/workspace" || [...this.#files.keys()].some(filePath => filePath.startsWith(`${candidate}/`))
  }
}

function result(stdout = "", stderr = "", exitCode = 0): Readonly<SandboxExecResult> {
  return Object.freeze({ exitCode, stderr, stdout })
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: controller => controller.close() })
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
