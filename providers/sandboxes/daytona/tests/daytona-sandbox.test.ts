import { execFile } from "node:child_process"
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { DaytonaFileNotFoundError, type Daytona, type Sandbox as DaytonaSdkSandbox } from "@daytona/sdk"
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
  it("uses the AML Agent Sandbox image by default", async () => {
    const workspace = await temporaryDirectory("aml-daytona-default-image-")
    await mkdir(path.join(workspace, "repository"), { recursive: true })
    const fake = await FakeDaytona.create()
    const lease = await daytonaSandbox({ client: fake.client, workspace }).acquire(request())

    expect(fake.createCalls).toEqual([
      {
        options: undefined,
        params: {
          image: "wearesingular/aml-agent-sandbox:latest",
        },
      },
    ])

    await lease.release()
  })

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

    await lease.runtime.writeFile("repository/context.txt", new TextEncoder().encode("context"))
    expect(await lease.runtime.stat("repository/context.txt")).toEqual({
      kind: "file",
      modifiedAtMs: expect.any(Number),
      size: 7,
    })
    fake.modifiedAt = "not-a-timestamp"
    expect(await lease.runtime.stat("repository/context.txt")).toEqual({ kind: "file", size: 7 })
    expect(new TextDecoder().decode(await lease.runtime.readFile("repository/context.txt"))).toBe("context")
    const staging = await lease.runtime.createFileStaging()
    await staging.writeFile(".agents/skills/review/SKILL.md", new TextEncoder().encode("skill"))
    expect(fake.files.get(`${staging.root}/.agents/skills/review/SKILL.md`)).toEqual(Buffer.from("skill"))
    await staging.release()
    expect([...fake.files.keys()]).not.toContainEqual(expect.stringContaining(staging.root))

    const spawned = await lease.runtime.spawn("node", ["server.mjs"], {
      cwd: "repository/src",
      env: { API_KEY: "configured" },
    })
    const writer = spawned.stdin.getWriter()
    await writer.write(new TextEncoder().encode("input"))
    await writer.close()
    const [stdout, stderr, exit] = await Promise.all([
      readStream(spawned.stdout),
      readStream(spawned.stderr),
      spawned.wait(),
    ])

    expect({ exit, stderr, stdout }).toEqual({
      exit: { exitCode: 0 },
      stderr: "spawn error",
      stdout: "spawn output",
    })
    expect(fake.sessionCommands[0]?.request).toMatchObject({
      command: expect.stringContaining("exec 'node' 'server.mjs'"),
      runAsync: true,
      suppressInputEcho: true,
    })
    expect(fake.sessionInputs).toEqual(["input"])

    await lease.release()
    await expect(readFile(path.join(repository, "output.txt"), "utf8")).resolves.toBe("downloaded")
    await expect(readFile(path.join(repository, "input.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(fake.deleteCount).toBe(1)
  })

  it("caches a killed exit when Daytona deletes the owned process session", async () => {
    const workspace = await temporaryDirectory("aml-daytona-kill-")
    const fake = await FakeDaytona.create()
    const releaseLogs = fake.pauseSessionLogs()
    const lease = await daytonaSandbox({ client: fake.client, workspace }).acquire(request({ cwd: ".", root: "." }))
    const process = await lease.runtime.spawn("node", ["server.mjs"])
    const writer = process.stdin.getWriter()

    await Promise.all([process.kill(), process.kill(), writer.close()])
    releaseLogs()

    const [first, second, stdout, stderr] = await Promise.all([
      process.wait(),
      process.wait(),
      readStream(process.stdout),
      readStream(process.stderr),
    ])
    expect(first).toBe(second)
    expect({ exit: first, stderr, stdout }).toEqual({ exit: { exitCode: 137 }, stderr: "", stdout: "" })
    await expect(writer.write(new TextEncoder().encode("late"))).rejects.toThrow()

    await lease.release()
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

  it("rejects special entries from portable file operations", async () => {
    const workspace = await temporaryDirectory("aml-daytona-special-file-")
    await mkdir(path.join(workspace, "repository"), { recursive: true })
    const fake = await FakeDaytona.create()
    fake.files.set("workspace/special", Buffer.from("special"))
    fake.fileModes.set("workspace/special", "prw-------")
    const lease = await daytonaSandbox({ client: fake.client, workspace }).acquire(request())

    await expect(lease.runtime.readFile("repository/special")).rejects.toThrow("must identify a regular file")
    await expect(lease.runtime.stat("repository/special")).rejects.toThrow("must identify a regular file or directory")
    await lease.release()
  })

  it("rejects directory and symbolic-link file destinations", async () => {
    const workspace = await temporaryDirectory("aml-daytona-file-destination-")
    await mkdir(path.join(workspace, "repository"), { recursive: true })
    const fake = await FakeDaytona.create()
    const lease = await daytonaSandbox({ client: fake.client, workspace }).acquire(request())
    fake.directories.add("workspace/directory")
    fake.files.set("workspace/link", Buffer.from("target"))
    fake.fileModes.set("workspace/link", "lrwxrwxrwx")

    await expect(lease.runtime.writeFile("repository/directory", new TextEncoder().encode("content"))).rejects.toThrow(
      "file destination must be a regular file"
    )
    await expect(lease.runtime.writeFile("repository/link", new TextEncoder().encode("content"))).rejects.toThrow(
      "file destination must be a regular file"
    )
    await lease.release()
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
  readonly directories = new Set<string>(["/", "/tmp", "workspace"])
  downloadCount = 0
  readonly fileModes = new Map<string, string>()
  readonly files = new Map<string, Buffer>()
  modifiedAt = "1970-01-01T00:00:01.000Z"
  readonly remoteWorkspace: string
  readonly sessionCommands: Array<{ request: Record<string, unknown>; sessionId: string }> = []
  readonly sessionInputs: string[] = []
  #sessionDeleted = false
  #sessionLogGate: Promise<void> = Promise.resolve()
  readonly uploadedArchive: string
  readonly #downloadArchive: string

  private constructor(directory: string) {
    this.remoteWorkspace = path.join(directory, "remote-workspace")
    this.uploadedArchive = path.join(directory, "uploaded.tar")
    this.#downloadArchive = path.join(directory, "download.tar")
    const sandbox = {
      fs: {
        createFolder: async (remotePath: string) => {
          this.directories.add(remotePath)
        },
        deleteFile: async (remotePath: string, recursive = false) => {
          this.directories.delete(remotePath)
          this.files.delete(remotePath)

          if (recursive) {
            for (const directoryPath of this.directories) {
              if (directoryPath.startsWith(`${remotePath}/`)) this.directories.delete(directoryPath)
            }
            for (const filePath of this.files.keys()) {
              if (filePath.startsWith(`${remotePath}/`)) this.files.delete(filePath)
            }
          }
        },
        downloadFile: async (remotePath: string, localPath?: string) => {
          if (localPath === undefined) {
            const content = this.files.get(remotePath)
            if (content === undefined) throw new Error(`missing remote file ${remotePath}`)
            return Buffer.from(content)
          }

          this.downloadCount += 1
          await cp(this.#downloadArchive, localPath)
        },
        getFileDetails: async (remotePath: string) => {
          const content = this.files.get(remotePath)

          if (content !== undefined) {
            return {
              isDir: false,
              mode: this.fileModes.get(remotePath) ?? "-rw-r--r--",
              modifiedAt: this.modifiedAt,
              size: content.byteLength,
            }
          }

          if (this.directories.has(remotePath)) {
            return { isDir: true, mode: "drwxr-xr-x", modifiedAt: this.modifiedAt, size: 0 }
          }

          throw new DaytonaFileNotFoundError(`missing remote path ${remotePath}`)
        },
        moveFiles: async (source: string, destination: string) => {
          const content = this.files.get(source)
          if (content === undefined) throw new Error(`missing remote file ${source}`)
          const target = this.directories.has(destination)
            ? path.posix.join(destination, path.posix.basename(source))
            : destination
          this.files.set(target, content)
          this.files.delete(source)
        },
        uploadFile: async (content: Buffer, remotePath: string) => {
          this.files.set(remotePath, Buffer.from(content))
        },
        uploadFileStream: async (localPath: string) => {
          await cp(localPath, this.uploadedArchive)
        },
      },
      id: "daytona-test",
      process: {
        createSession: async () => {},
        deleteSession: async () => {
          this.#sessionDeleted = true
        },
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
        executeSessionCommand: async (sessionId: string, request: Record<string, unknown>) => {
          this.sessionCommands.push({ request, sessionId })
          return { cmdId: "command-1" }
        },
        getSessionCommand: async () => {
          if (this.#sessionDeleted) {
            throw Object.assign(new Error("session not found"), { code: "PROCESS_NOT_FOUND", statusCode: 404 })
          }
          return { command: "spawn", exitCode: 0, id: "command-1" }
        },
        getSessionCommandLogs: async (
          _sessionId: string,
          _commandId: string,
          onStdout: (chunk: string) => void,
          onStderr: (chunk: string) => void
        ) => {
          await this.#sessionLogGate
          if (this.#sessionDeleted) return
          onStdout("spawn output")
          onStderr("spawn error")
        },
        sendSessionCommandInput: async (_sessionId: string, _commandId: string, data: string) => {
          this.sessionInputs.push(data)
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

  pauseSessionLogs(): () => void {
    let release!: () => void
    this.#sessionLogGate = new Promise<void>(resolve => (release = resolve))
    return release
  }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf8")
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
