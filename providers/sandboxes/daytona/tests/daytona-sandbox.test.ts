import { execFile } from "node:child_process"
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import type { Daytona, Sandbox as DaytonaSdkSandbox } from "@daytona/sdk"
import { afterEach, describe, expect, it } from "vitest"

import type { SandboxAcquireRequest } from "@aml-jsx/sdk"

import { daytonaSandbox, type DaytonaSandboxOptions } from "../src/index.js"

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async directory => await rm(directory, { force: true, recursive: true }))
  )
})

describe("daytonaSandbox()", () => {
  it("uses native creation config and reconciles the complete Workspace", async () => {
    const workspace = await temporaryDirectory("aml-daytona-workspace-")
    const repository = path.join(workspace, "repository")
    await mkdir(path.join(repository, "src"), { recursive: true })
    await writeFile(path.join(repository, "input.txt"), "uploaded")

    const fake = await FakeDaytona.create()
    await writeFile(path.join(fake.remoteWorkspace, "output.txt"), "downloaded")
    const provider = daytonaSandbox({
      client: fake.client,
      createOptions: {
        timeout: 45,
      },
      setup: "prepare agent",
      snapshot: "agent-snapshot",
      workspace,
    })
    const lease = await provider.acquire(request())

    expect(fake.createCalls).toEqual([
      {
        options: { timeout: 45 },
        params: { snapshot: "agent-snapshot" },
      },
    ])
    expect(await archiveFile(fake.uploadedArchive, "input.txt")).toBe("uploaded")
    expect(fake.commands).toContainEqual({
      command: "'sh' '-lc' 'prepare agent'",
      cwd: "workspace",
    })

    const result = await lease.runtime.exec("node", ["agent.mjs", "hello; literal"], {
      cwd: "repository/src",
      env: { API_KEY: "configured" },
      timeoutMs: 1_500,
    })

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "command output",
    })
    expect(fake.commands.at(-1)).toEqual({
      command: "'node' 'agent.mjs' 'hello; literal'",
      cwd: "workspace/src",
      env: { API_KEY: "configured" },
      timeout: 2,
    })

    await lease.release()
    await expect(readFile(path.join(repository, "output.txt"), "utf8")).resolves.toBe("downloaded")
    await expect(readFile(path.join(repository, "input.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(fake.deleteCount).toBe(1)
  })

  it("combines a root image with native image creation parameters", async () => {
    const workspace = await temporaryDirectory("aml-daytona-image-")
    await mkdir(path.join(workspace, "repository"), { recursive: true })
    const fake = await FakeDaytona.create()
    const onSnapshotCreateLogs = () => undefined
    const lease = await daytonaSandbox({
      client: fake.client,
      create: {
        envVars: {
          NODE_ENV: "test",
        },
      },
      createOptions: {
        onSnapshotCreateLogs,
        timeout: 30,
      },
      image: "node:26",
      workspace,
    }).acquire(request())

    expect(fake.createCalls).toEqual([
      {
        options: {
          onSnapshotCreateLogs,
          timeout: 30,
        },
        params: {
          envVars: {
            NODE_ENV: "test",
          },
          image: "node:26",
        },
      },
    ])

    await lease.release()
    expect(fake.deleteCount).toBe(1)
  })

  it("does not claim read-only enforcement for transferred Workspaces", async () => {
    const workspace = await temporaryDirectory("aml-daytona-read-only-")
    await mkdir(path.join(workspace, "repository"), { recursive: true })
    const fake = await FakeDaytona.create()
    const lease = await daytonaSandbox({
      client: fake.client,
      workspace,
    }).acquire(request({ access: "read-only" }))

    await expect(lease.runtime.exec("pwd")).rejects.toThrow("cannot execute under read-only access")
    await lease.release()

    expect(fake.downloadCount).toBe(0)
    expect(fake.deleteCount).toBe(1)
  })

  it("validates AML options without constructing a credentialed client", () => {
    expect(() => daytonaSandbox()).not.toThrow()
    expect(() =>
      daytonaSandbox({
        client: {} as Daytona,
        config: { apiKey: "configured" },
      })
    ).toThrow("either client or config")
    expect(() =>
      daytonaSandbox({
        create: { image: "node:26" },
      } as unknown as DaytonaSandboxOptions)
    ).toThrow("image and snapshot are root options")
    expect(() =>
      daytonaSandbox({
        create: { snapshot: "agent-snapshot" },
      } as unknown as DaytonaSandboxOptions)
    ).toThrow("image and snapshot are root options")
    expect(() =>
      daytonaSandbox({
        image: "node:26",
        snapshot: "agent-snapshot",
      } as unknown as DaytonaSandboxOptions)
    ).toThrow("either image or snapshot")
    expect(() => daytonaSandbox({ maxOutputBytes: 0 })).toThrow("maxOutputBytes must be a positive safe integer")
    expect(() => daytonaSandbox({ setup: "" })).toThrow("setup must be a non-empty string")
  })
})

interface RecordedCommand {
  readonly command: string
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly timeout?: number
}

class FakeDaytona {
  readonly client: Daytona
  readonly commands: RecordedCommand[] = []
  readonly createCalls: Array<{ options: unknown; params: unknown }> = []
  deleteCount = 0
  downloadCount = 0
  readonly remoteWorkspace: string
  readonly uploadedArchive: string
  readonly #downloadArchive: string

  private constructor(directory: string) {
    this.remoteWorkspace = path.join(directory, "remote-workspace")
    this.uploadedArchive = path.join(directory, "uploaded.tar")
    this.#downloadArchive = path.join(directory, "download.tar")
    const sandbox = {
      fs: {
        deleteFile: async () => {},
        downloadFile: async (_remotePath: string, localPath: string) => {
          this.downloadCount += 1
          await cp(this.#downloadArchive, localPath)
        },
        uploadFileStream: async (localPath: string) => {
          await cp(localPath, this.uploadedArchive)
        },
      },
      id: "daytona-test",
      process: {
        executeCommand: async (command: string, cwd?: string, env?: Record<string, string>, timeout?: number) => {
          this.commands.push({
            command,
            ...(cwd === undefined ? {} : { cwd }),
            ...(env === undefined ? {} : { env }),
            ...(timeout === undefined ? {} : { timeout }),
          })

          if (command.startsWith("tar -C 'workspace'")) {
            await execFileAsync("tar", ["-C", this.remoteWorkspace, "-cf", this.#downloadArchive, "."])
          }

          return {
            exitCode: 0,
            result: command.startsWith("'") ? "command output" : "",
          }
        },
      },
    } as unknown as DaytonaSdkSandbox
    const client = {
      create: async (params: unknown, options: unknown) => {
        this.createCalls.push({ options, params })
        return sandbox
      },
      delete: async () => {
        this.deleteCount += 1
      },
    }

    this.client = client as unknown as Daytona
  }

  static async create(): Promise<FakeDaytona> {
    const directory = await temporaryDirectory("aml-daytona-fake-")
    const fake = new FakeDaytona(directory)
    await mkdir(fake.remoteWorkspace, { recursive: true })
    return fake
  }
}

function request(overrides: Partial<SandboxAcquireRequest> = {}): Readonly<SandboxAcquireRequest> {
  return Object.freeze({
    access: "read-write",
    cwd: "repository",
    evaluationId: "daytona-test",
    root: "repository",
    signal: new AbortController().signal,
    ...overrides,
  })
}

async function archiveFile(archive: string, file: string): Promise<string> {
  const directory = await temporaryDirectory("aml-daytona-archive-")
  await execFileAsync("tar", ["-C", directory, "-xf", archive])
  return await readFile(path.join(directory, file), "utf8")
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}
