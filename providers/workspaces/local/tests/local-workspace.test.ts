import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { WorkspaceConflictError, type WorkspaceAcquireRequest } from "@aml-jsx/sdk"
import { workspaceProviderConformance } from "@aml-jsx/sdk/testing"

import { localWorkspace } from "../src/index.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async directory => {
      await rm(directory, { force: true, recursive: true })
      await rm(`${directory}.lock`, {
        force: true,
        recursive: true,
      })
    })
  )
})

describe("localWorkspace()", () => {
  it("constructs lazily and validates configured options", async () => {
    expect(() =>
      localWorkspace({
        directory: " relative-directory ",
      })
    ).toThrow("non-empty normalized string")

    const missing = path.join(tmpdir(), `aml-missing-${crypto.randomUUID()}`)
    const provider = localWorkspace({ directory: missing })

    expect(provider.name).toBe("local")
    await expect(provider.acquire(createRequest("missing"))).rejects.toThrow("cannot be materialized")

    let directoryReads = 0
    const capturedDirectory = path.join(tmpdir(), `aml-captured-${crypto.randomUUID()}`)
    const hostileOptions = {
      get directory() {
        directoryReads += 1
        return directoryReads === 4 ? "" : capturedDirectory
      },
    }
    const capturedProvider = localWorkspace(hostileOptions)

    expect(directoryReads).toBe(1)
    await expect(capturedProvider.acquire(createRequest("captured"))).rejects.toThrow(capturedDirectory)
    expect(() =>
      localWorkspace({
        directory: capturedDirectory,
        staleMs: 1_999,
      })
    ).toThrow("staleMs")
    expect(() =>
      localWorkspace({
        directory: capturedDirectory,
        staleMs: 10_000,
        updateMs: 5_001,
      })
    ).toThrow("half of staleMs")
    expect(() =>
      localWorkspace({
        directory: capturedDirectory,
        staleMs: 2_147_483_648,
      })
    ).toThrow("2147483647")
  })

  it("materializes the physical directory and persists direct writes", async () => {
    const directory = await createTemporaryDirectory()
    const provider = localWorkspace({ directory })
    const first = await provider.acquire(createRequest("repository"))

    expect(first.directory).toBe(await realpath(directory))
    expect(first.handle).toEqual({
      directory: await realpath(directory),
      kind: "local-workspace",
    })
    expect(Object.isFrozen(first.handle)).toBe(true)
    await writeFile(path.join(first.directory, "finding.txt"), "persisted finding")
    await first.save()
    await first.release()
    await first.release()

    const second = await provider.acquire(createRequest("repository"))

    await expect(readFile(path.join(second.directory, "finding.txt"), "utf8")).resolves.toBe("persisted finding")
    await second.save()
    await second.release()
    await expect(stat(`${directory}.lock`)).rejects.toHaveProperty("code", "ENOENT")
  })

  it("resolves symlinks before exposing and locking materialization", async () => {
    const directory = await createTemporaryDirectory()
    const link = `${directory}-link`
    temporaryDirectories.push(link)
    await symlink(directory, link, "dir")
    const lease = await localWorkspace({
      directory: link,
    }).acquire(createRequest("symlinked"))

    expect(lease.directory).toBe(await realpath(directory))
    await lease.release()
  })

  it("rejects competing providers for one physical directory", async () => {
    const directory = await createTemporaryDirectory()
    const firstProvider = localWorkspace({ directory })
    const secondProvider = localWorkspace({ directory })
    const first = await firstProvider.acquire(createRequest("first-logical-id"))
    const conflict = await secondProvider.acquire(createRequest("second-logical-id")).catch((error: unknown) => error)

    expect(WorkspaceConflictError.is(conflict, "second-logical-id")).toBe(true)

    await first.release()
    const second = await secondProvider.acquire(createRequest("second-logical-id"))
    await second.release()
  })

  it("enforces contention across processes and canonical paths", async () => {
    const directory = await createTemporaryDirectory()
    const link = `${directory}-child-link`
    temporaryDirectories.push(link)
    await symlink(directory, link, "dir")
    const repositoryRoot = path.resolve(import.meta.dirname, "../../../..")
    const child = spawn(
      process.execPath,
      [
        path.join(repositoryRoot, "node_modules/vite-node/dist/cli.mjs"),
        path.join(import.meta.dirname, "fixtures/hold-local-workspace.ts"),
        link,
      ],
      {
        cwd: repositoryRoot,
        stdio: ["pipe", "pipe", "pipe"],
      }
    )

    try {
      await waitForChildText(child, "locked")
      const provider = localWorkspace({ directory })
      const conflict = await provider.acquire(createRequest("parent-contender")).catch((error: unknown) => error)

      expect(WorkspaceConflictError.is(conflict, "parent-contender")).toBe(true)

      const exited = once(child, "exit")
      child.stdin.write("release\n")
      await waitForChildText(child, "released")
      const [exitCode] = await exited

      expect(exitCode).toBe(0)
      const reacquired = await provider.acquire(createRequest("parent-contender"))
      await reacquired.release()
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM")
        await once(child, "exit")
      }
    }
  })

  it("preserves cancellation before filesystem or lock acquisition", async () => {
    const directory = await createTemporaryDirectory()
    const controller = new AbortController()
    const reason = new Error("cancel local Workspace")
    controller.abort(reason)

    await expect(localWorkspace({ directory }).acquire(createRequest("cancelled", controller.signal))).rejects.toBe(
      reason
    )
    await expect(stat(`${directory}.lock`)).rejects.toHaveProperty("code", "ENOENT")
  })

  it("passes the provider-neutral Workspace conformance suite", async () => {
    const directory = await createTemporaryDirectory()

    await expect(workspaceProviderConformance(localWorkspace({ directory }))).resolves.toBeUndefined()
    await expect(stat(`${directory}.lock`)).rejects.toHaveProperty("code", "ENOENT")
  })
})

/**
 * Creates one tracked existing directory for a filesystem behavior test.
 */
async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "aml-workspace-local-"))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * Builds one immutable direct-provider acquisition request.
 */
function createRequest(id: string, signal = new AbortController().signal): Readonly<WorkspaceAcquireRequest> {
  return Object.freeze({
    evaluationId: `local-workspace-test-${id}`,
    id,
    signal,
  })
}

/**
 * Waits for one child-process protocol marker and includes stderr on failure.
 */
function waitForChildText(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for Local Workspace child "${expected}": ${stderr}`))
    }, 10_000)
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8")

      if (stdout.includes(expected)) {
        cleanup()
        resolve()
      }
    }
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    }
    const onExit = (code: number | null) => {
      cleanup()
      reject(new Error(`Local Workspace child exited with ${code}: ${stderr}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.stdout.off("data", onStdout)
      child.stderr.off("data", onStderr)
      child.off("exit", onExit)
    }

    child.stdout.on("data", onStdout)
    child.stderr.on("data", onStderr)
    child.once("exit", onExit)
  })
}
