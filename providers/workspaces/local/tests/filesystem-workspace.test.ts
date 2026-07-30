import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { type WorkspaceAcquireRequest, type WorkspaceSaveRequest } from "@aml-jsx/sdk"
import { workspaceProviderConformance } from "@aml-jsx/sdk/testing"

import { filesystemWorkspace } from "../src/index.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

describe("filesystemWorkspace()", () => {
  for (const format of ["archive", "folder"] as const) {
    it(`round-trips and retains ${format} revisions outside the active materialization`, async () => {
      const directory = await createTemporaryDirectory()
      const temporaryDirectory = await createTemporaryDirectory()
      const provider = filesystemWorkspace({
        directory,
        format,
        temporaryDirectory,
      })
      const first = await provider.acquire(createRequest(`${format}-round-trip`, false))
      const firstMaterialization = first.directory

      expect(first.directory.startsWith(temporaryDirectory)).toBe(true)
      expect(first.directory.startsWith(directory)).toBe(false)
      await writeFile(path.join(first.directory, "value.txt"), "first")
      await first.save(saveRequest(2))
      await writeFile(path.join(first.directory, "value.txt"), "second")
      await first.save(saveRequest(2))
      await first.release()
      await expect(stat(firstMaterialization)).rejects.toHaveProperty("code", "ENOENT")

      const restored = await provider.acquire(createRequest(`${format}-round-trip`))
      await expect(readFile(path.join(restored.directory, "value.txt"), "utf8")).resolves.toBe("second")
      await restored.release()

      const storageRoot = path.join(directory, `${format}-round-trip`)
      const index = JSON.parse(await readFile(path.join(storageRoot, "workspace.json"), "utf8")) as {
        readonly revisions: readonly unknown[]
      }
      expect(index.revisions).toHaveLength(2)

      const revisionEntries = await readdir(path.join(storageRoot, "revisions"))
      expect(revisionEntries).toHaveLength(2)
    })
  }

  it("defaults to archive and passes provider conformance", async () => {
    const directory = await createTemporaryDirectory()
    const temporaryDirectory = await createTemporaryDirectory()
    const provider = filesystemWorkspace({ directory, temporaryDirectory })

    await expect(workspaceProviderConformance(provider)).resolves.toBeUndefined()
    const storageRoots = await readdir(directory)
    expect(storageRoots).toHaveLength(1)
  })

  it("allows unlocked materializations but rejects stale publication", async () => {
    const directory = await createTemporaryDirectory()
    const temporaryDirectory = await createTemporaryDirectory()
    const provider = filesystemWorkspace({ directory, temporaryDirectory })
    const first = await provider.acquire(createRequest("unlocked", false, false))
    const stale = await provider.acquire(createRequest("unlocked", false, false))
    await writeFile(path.join(first.directory, "winner.txt"), "first")
    await writeFile(path.join(stale.directory, "stale.txt"), "second")

    await first.save()
    await expect(stale.save()).rejects.toThrow("conditional write failed")
    await first.release()
    await stale.release()

    const restored = await provider.acquire(createRequest("unlocked"))
    await expect(readFile(path.join(restored.directory, "winner.txt"), "utf8")).resolves.toBe("first")
    await expect(stat(path.join(restored.directory, "stale.txt"))).rejects.toHaveProperty("code", "ENOENT")
    await restored.release()
  })
})

function createRequest(
  id: string,
  load:
    | false
    | {
        readonly exclude: readonly string[]
        readonly revision: "current"
      } = {
    exclude: [],
    revision: "current",
  },
  lock = true
): Readonly<WorkspaceAcquireRequest> {
  return Object.freeze({
    evaluationId: `filesystem-workspace-test-${id}`,
    id,
    load,
    lock,
    save: true,
    signal: new AbortController().signal,
  })
}

function saveRequest(retention: number): Readonly<WorkspaceSaveRequest> {
  return Object.freeze({
    exclude: Object.freeze([]),
    gitignore: true,
    outcome: "success",
    retention,
    signal: new AbortController().signal,
  })
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aml-filesystem-workspace-"))
  temporaryDirectories.push(directory)
  return directory
}
