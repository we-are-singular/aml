import { execFile } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import type { ModalClient, Sandbox as ModalSdkSandbox } from "modal"
import { afterEach, describe, expect, it } from "vitest"

import type { SandboxAcquireRequest } from "@aml-jsx/sdk"
import { sandboxProviderConformance } from "@aml-jsx/sdk/testing"

import { modalSandbox } from "../src/index.js"

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async directory => await rm(directory, { force: true, recursive: true }))
  )
})

describe("modalSandbox()", () => {
  it("uses native creation config and reconciles the complete Workspace", async () => {
    const workspace = await temporaryDirectory("aml-modal-workspace-")
    const repository = path.join(workspace, "repository")
    await mkdir(path.join(repository, "src"), { recursive: true })
    await writeFile(path.join(repository, "input.txt"), "uploaded")

    const fake = await FakeModal.create()
    await writeFile(path.join(fake.remoteWorkspace, "output.txt"), "downloaded")
    const provider = modalSandbox({
      appName: "aml-tests",
      client: fake.client,
      create: {
        cpu: 2,
        timeoutMs: 60_000,
      },
      setup: "prepare agent",
      workspace,
    })
    const lease = await provider.acquire(request())

    expect(fake.appCalls).toEqual([{ createIfMissing: true, name: "aml-tests" }])
    expect(fake.imageCalls).toEqual(["wearesingular/aml-agent-sandbox:latest"])
    expect(fake.createCalls).toEqual([
      {
        app: { appId: "ap-test" },
        image: { imageId: "im-test" },
        params: { cpu: 2, timeoutMs: 60_000 },
      },
    ])
    expect(await archiveFile(fake.uploadedArchive, "input.txt")).toBe("uploaded")
    expect(fake.commands).toContainEqual({
      command: ["sh", "-lc", "prepare agent"],
      env: {},
      workdir: "/workspace",
    })

    const result = await lease.runtime.exec("node", ["agent.mjs", "hello; literal"], {
      cwd: "repository/src",
      env: { API_KEY: "configured" },
      timeoutMs: 1_500,
    })

    expect(result).toEqual({
      exitCode: 0,
      stderr: "command error",
      stdout: "command output",
    })
    expect(fake.commands.at(-1)).toEqual({
      command: ["node", "agent.mjs", "hello; literal"],
      env: { API_KEY: "configured" },
      timeoutMs: 1_500,
      workdir: "/workspace/src",
    })
    expect(fake.stdinCloseCount).toBeGreaterThanOrEqual(2)

    await lease.runtime.writeFile("repository/context.txt", new TextEncoder().encode("context"))
    expect(await lease.runtime.stat("repository/context.txt")).toEqual({
      kind: "file",
      modifiedAtMs: expect.any(Number),
      size: 7,
    })
    fake.modifiedTime = Number.NaN
    expect(await lease.runtime.stat("repository/context.txt")).toEqual({ kind: "file", size: 7 })
    expect(new TextDecoder().decode(await lease.runtime.readFile("repository/context.txt"))).toBe("context")
    const staging = await lease.runtime.createFileStaging()
    await staging.writeFile(".agents/skills/review/SKILL.md", new TextEncoder().encode("skill"))
    expect(fake.files.get(`${staging.root}/.agents/skills/review/SKILL.md`)).toEqual(new TextEncoder().encode("skill"))
    await staging.release()
    expect([...fake.files.keys()]).not.toContainEqual(expect.stringContaining(staging.root))

    const spawned = await lease.runtime.spawn("node", ["server.mjs"], {
      cwd: "repository/src",
    })
    const writer = spawned.stdin.getWriter()
    await writer.write(new TextEncoder().encode("input"))
    await writer.close()
    await expect(spawned.wait()).resolves.toEqual({ exitCode: 0 })
    expect(fake.commands.at(-1)).toMatchObject({
      command: ["sh", "-c", expect.stringContaining('exec "$@"'), "aml-spawn", "node", "server.mjs"],
      workdir: "/workspace/src",
    })

    await lease.release()
    await expect(readFile(path.join(repository, "output.txt"), "utf8")).resolves.toBe("downloaded")
    await expect(readFile(path.join(repository, "input.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(fake.terminateCount).toBe(1)
  })

  it("does not claim read-only enforcement for transferred Workspaces", async () => {
    const workspace = await temporaryDirectory("aml-modal-read-only-")
    await mkdir(path.join(workspace, "repository"), { recursive: true })
    const fake = await FakeModal.create()
    const lease = await modalSandbox({
      client: fake.client,
      image: "alpine:3.22",
      workspace,
    }).acquire(request({ access: "read-only" }))

    await expect(lease.runtime.exec("pwd")).rejects.toThrow("cannot execute under read-only access")
    await lease.release()

    expect(fake.downloadCount).toBe(0)
    expect(fake.terminateCount).toBe(1)
  })

  it("rejects an existing directory as a file replacement destination", async () => {
    const workspace = await temporaryDirectory("aml-modal-directory-destination-")
    await mkdir(path.join(workspace, "repository"), { recursive: true })
    const fake = await FakeModal.create()
    fake.directories.add("/workspace/generated")
    const lease = await modalSandbox({
      client: fake.client,
      image: "alpine:3.22",
      workspace,
    }).acquire(request())

    await expect(lease.runtime.writeFile("repository/generated", new TextEncoder().encode("content"))).rejects.toThrow(
      "Modal Sandbox file replacement failed: destination is a directory"
    )
    expect([...fake.files.keys()]).not.toContainEqual(expect.stringContaining(".aml-file-"))

    await lease.release()
  })

  it("validates AML options without constructing a credentialed client", () => {
    expect(() => modalSandbox()).not.toThrow()
    expect(() => modalSandbox({ image: "node:26" })).not.toThrow()
    expect(() =>
      modalSandbox({
        client: {} as ModalClient,
        config: { tokenId: "configured", tokenSecret: "configured" },
        image: "node:26",
      })
    ).toThrow("either client or config")
    expect(() => modalSandbox({ image: "", maxOutputBytes: 1 })).toThrow("image must be a non-empty string")
    expect(() => modalSandbox({ image: "node:26", maxOutputBytes: 0 })).toThrow(
      "maxOutputBytes must be a positive safe integer"
    )
    expect(() => modalSandbox({ image: "node:26", setup: "" })).toThrow("setup must be a non-empty string")
  })

  it("passes the provider lifecycle conformance suite", async () => {
    const workspace = await temporaryDirectory("aml-modal-conformance-")
    const fake = await FakeModal.create()

    await expect(
      sandboxProviderConformance(
        modalSandbox({
          client: fake.client,
          image: "alpine:3.22",
          workspace,
        })
      )
    ).resolves.toBeUndefined()
    expect(fake.terminateCount).toBe(1)
  })
})

interface RecordedCommand {
  readonly command: string[]
  readonly env?: Record<string, string>
  readonly timeoutMs?: number
  readonly workdir?: string
}

class FakeModal {
  readonly appCalls: Array<{ createIfMissing: boolean; name: string }> = []
  readonly client: ModalClient
  readonly commands: RecordedCommand[] = []
  readonly createCalls: Array<{ app: unknown; image: unknown; params: unknown }> = []
  readonly directories = new Set<string>()
  downloadCount = 0
  readonly files = new Map<string, Uint8Array>()
  readonly imageCalls: string[] = []
  modifiedTime = 1
  readonly remoteWorkspace: string
  stdinCloseCount = 0
  terminateCount = 0
  readonly uploadedArchive: string
  readonly #downloadArchive: string

  private constructor(directory: string) {
    this.remoteWorkspace = path.join(directory, "remote-workspace")
    this.uploadedArchive = path.join(directory, "uploaded.tar")
    this.#downloadArchive = path.join(directory, "download.tar")

    const sandbox = {
      exec: async (command: string[], params: Record<string, unknown> = {}) => {
        const recorded: RecordedCommand = {
          command,
          ...(params.env === undefined ? {} : { env: params.env as Record<string, string> }),
          ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs as number }),
          ...(params.workdir === undefined ? {} : { workdir: params.workdir as string }),
        }
        this.commands.push(recorded)

        let exitCode = 0
        let stderr = ""

        if (command[0] === "mv") {
          const source = command.at(-2)
          const destination = command.at(-1)
          const content = source === undefined ? undefined : this.files.get(source)

          if (source !== undefined && content !== undefined && destination !== undefined) {
            if (this.directories.has(destination) && command.includes("-T")) {
              exitCode = 1
              stderr = "destination is a directory"
            } else {
              const resolvedDestination = this.directories.has(destination)
                ? path.posix.join(destination, path.posix.basename(source))
                : destination
              this.files.set(resolvedDestination, content)
            }
            this.files.delete(source)
          }
        }

        if (command[0] === "tar" && command.includes("-cf")) {
          await execFileAsync("tar", ["-C", this.remoteWorkspace, "-cf", this.#downloadArchive, "."])
        }

        const isRuntimeCommand = command[0] === "node"
        return processResult(
          isRuntimeCommand ? "command output" : "",
          isRuntimeCommand ? "command error" : stderr,
          params.mode === "binary",
          () => {
            this.stdinCloseCount += 1
          },
          exitCode
        )
      },
      filesystem: {
        copyFromLocal: async (localPath: string) => {
          await cp(localPath, this.uploadedArchive)
        },
        copyToLocal: async (_remotePath: string, localPath: string) => {
          this.downloadCount += 1
          await cp(this.#downloadArchive, localPath)
        },
        makeDirectory: async () => {},
        readBytes: async (remotePath: string) => {
          const content = this.files.get(remotePath)
          if (content === undefined) throw new Error(`missing remote file ${remotePath}`)
          return Uint8Array.from(content)
        },
        remove: async (remotePath: string, options: { recursive?: boolean } = {}) => {
          this.files.delete(remotePath)

          if (options.recursive) {
            for (const filePath of this.files.keys()) {
              if (filePath.startsWith(`${remotePath}/`)) this.files.delete(filePath)
            }
          }
        },
        stat: async (remotePath: string) => {
          const content = this.files.get(remotePath)

          if (content === undefined) throw new Error(`missing remote file ${remotePath}`)
          return { modifiedTime: this.modifiedTime, size: content.byteLength, type: "file" }
        },
        writeBytes: async (content: Uint8Array, remotePath: string) => {
          this.files.set(remotePath, Uint8Array.from(content))
        },
      },
      sandboxId: "sb-test",
      terminate: async () => {
        this.terminateCount += 1
      },
    } as unknown as ModalSdkSandbox

    this.client = {
      apps: {
        fromName: async (name: string, params: { createIfMissing: boolean }) => {
          this.appCalls.push({ createIfMissing: params.createIfMissing, name })
          return { appId: "ap-test" }
        },
      },
      images: {
        fromRegistry: (tag: string) => {
          this.imageCalls.push(tag)
          return { imageId: "im-test" }
        },
      },
      sandboxes: {
        create: async (app: unknown, image: unknown, params: unknown) => {
          this.createCalls.push({ app, image, params })
          return sandbox
        },
      },
    } as unknown as ModalClient
  }

  static async create(): Promise<FakeModal> {
    const directory = await temporaryDirectory("aml-modal-fake-")
    const fake = new FakeModal(directory)
    await mkdir(fake.remoteWorkspace, { recursive: true })
    return fake
  }
}

function processResult(stdout: string, stderr: string, binary: boolean, closeStdin: () => void, exitCode = 0) {
  return {
    closeStdin: async () => closeStdin(),
    stdin: {
      close: async () => closeStdin(),
      writeBytes: async () => {},
    },
    stderr: binary ? byteStream(stderr) : textStream(stderr),
    stdout: binary ? byteStream(stdout) : textStream(stdout),
    wait: async () => exitCode,
  }
}

function byteStream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value))
      controller.close()
    },
  })
}

function textStream(value: string): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value)
      controller.close()
    },
  })
}

function request(overrides: Partial<SandboxAcquireRequest> = {}): Readonly<SandboxAcquireRequest> {
  return Object.freeze({
    access: "read-write",
    cwd: "repository",
    evaluationId: "modal-test",
    root: "repository",
    signal: new AbortController().signal,
    ...overrides,
  })
}

async function archiveFile(archive: string, file: string): Promise<string> {
  const directory = await temporaryDirectory("aml-modal-archive-")
  await execFileAsync("tar", ["-C", directory, "-xf", archive])
  return await readFile(path.join(directory, file), "utf8")
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}
