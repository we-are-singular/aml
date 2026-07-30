import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  createPersistentWorkspaceProvider,
  workspaceStorageSegment,
  type WorkspaceAcquireRequest,
  type WorkspaceStorageAdapter,
  type WorkspaceStorageLease,
} from "../src/core.js"
import { InMemoryWorkspaceStorageAdapter, workspaceProviderConformance } from "../src/testing.js"
import { parseWorkspaceIndex } from "../src/workspace-persistence/workspace-index.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

describe("workspaceStorageSegment()", () => {
  it("keeps common identities readable and escapes path syntax", () => {
    expect(workspaceStorageSegment("client_42-thread.1722360000")).toBe("client_42-thread.1722360000")
    expect(workspaceStorageSegment("client/thread 42")).toBe("client%2Fthread%2042")
    expect(workspaceStorageSegment("..")).toBe("%2E%2E")
  })
})

describe("WorkspacePersistence", () => {
  it("defaults to archive and round-trips the selected tree", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const storage = new InMemoryWorkspaceStorageAdapter()
    const provider = createPersistentWorkspaceProvider({ storage, temporaryDirectory })
    const first = await provider.acquire(createRequest("archive", false))

    await writeFile(path.join(first.directory, ".gitignore"), "ignored.txt\n")
    await writeFile(path.join(first.directory, "kept.txt"), "kept")
    await writeFile(path.join(first.directory, "ignored.txt"), "ignored")
    await first.save(saveRequest({ retention: 3 }))
    await first.release()

    const second = await provider.acquire(createRequest("archive"))

    await expect(readFile(path.join(second.directory, "kept.txt"), "utf8")).resolves.toBe("kept")
    await expect(readFile(path.join(second.directory, ".gitignore"), "utf8")).resolves.toBe("ignored.txt\n")
    await expect(stat(path.join(second.directory, "ignored.txt"))).rejects.toHaveProperty("code", "ENOENT")
    await second.release()

    expect(storage.keys("archive").filter(key => key.endsWith(".tar.gz"))).toHaveLength(1)
    expect(storage.keys("archive")).toContain("workspace.json")
  })

  it("lets explicit includes override gitignore while excludes still win", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const storage = new InMemoryWorkspaceStorageAdapter()
    const provider = createPersistentWorkspaceProvider({ storage, temporaryDirectory })
    const included = await provider.acquire(createRequest("explicit-include", false))
    await writeFile(path.join(included.directory, ".gitignore"), "ignored.txt\n")
    await writeFile(path.join(included.directory, "ignored.txt"), "explicit")
    await included.save({
      ...saveRequest(),
      include: ["ignored.txt"],
    })
    await included.release()

    const restored = await provider.acquire(createRequest("explicit-include"))
    await expect(readFile(path.join(restored.directory, "ignored.txt"), "utf8")).resolves.toBe("explicit")
    await expect(stat(path.join(restored.directory, ".gitignore"))).rejects.toHaveProperty("code", "ENOENT")
    await restored.release()

    const excluded = await provider.acquire(createRequest("exclude-wins", false))
    await writeFile(path.join(excluded.directory, "ignored.txt"), "excluded")
    await excluded.save({
      ...saveRequest(),
      exclude: ["ignored.txt"],
      include: ["ignored.txt"],
    })
    await excluded.release()
    const empty = await provider.acquire(createRequest("exclude-wins"))
    await expect(stat(path.join(empty.directory, "ignored.txt"))).rejects.toHaveProperty("code", "ENOENT")
    await empty.release()
  })

  it("round-trips folder files, modes, and empty directories", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const storage = new InMemoryWorkspaceStorageAdapter()
    const provider = createPersistentWorkspaceProvider({
      format: "folder",
      storage,
      temporaryDirectory,
    })
    const first = await provider.acquire(createRequest("folder", false))

    await mkdir(path.join(first.directory, "empty"))
    await writeFile(path.join(first.directory, "run.sh"), "#!/bin/sh\n")
    await chmod(path.join(first.directory, "run.sh"), 0o755)
    await first.save(saveRequest())
    await first.release()

    const second = await provider.acquire(createRequest("folder"))
    const restoredMode = (await stat(path.join(second.directory, "run.sh"))).mode & 0o777

    await expect(stat(path.join(second.directory, "empty"))).resolves.toMatchObject({})
    await expect(readFile(path.join(second.directory, "run.sh"), "utf8")).resolves.toBe("#!/bin/sh\n")
    expect(restoredMode).toBe(0o755)
    await second.release()

    expect(storage.keys("folder")).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^revisions\/[^/]+\/files\/run\.sh$/),
        expect.stringMatching(/^revisions\/[^/]+\/manifest\.json$/),
        "workspace.json",
      ])
    )
  })

  it("loads an archive current revision before saving the next revision as a folder", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const storage = new InMemoryWorkspaceStorageAdapter()
    const archive = createPersistentWorkspaceProvider({ storage, temporaryDirectory })
    const first = await archive.acquire(createRequest("migration", false))
    await writeFile(path.join(first.directory, "first.txt"), "archive")
    await first.save(saveRequest({ retention: 3 }))
    await first.release()

    const folder = createPersistentWorkspaceProvider({
      format: "folder",
      storage,
      temporaryDirectory,
    })
    const second = await folder.acquire(createRequest("migration"))
    await expect(readFile(path.join(second.directory, "first.txt"), "utf8")).resolves.toBe("archive")
    await writeFile(path.join(second.directory, "second.txt"), "folder")
    await second.save(saveRequest({ retention: 3 }))
    await second.release()

    const restored = await archive.acquire(createRequest("migration"))
    await expect(readFile(path.join(restored.directory, "first.txt"), "utf8")).resolves.toBe("archive")
    await expect(readFile(path.join(restored.directory, "second.txt"), "utf8")).resolves.toBe("folder")
    await restored.release()

    const index = parseWorkspaceIndex((await storage.text("migration", "workspace.json"))!)
    expect(index.revisions.map(revision => revision.format)).toEqual(["folder", "archive"])
  })

  it("can save a clean materialization into the same linear history", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const storage = new InMemoryWorkspaceStorageAdapter()
    const provider = createPersistentWorkspaceProvider({ storage, temporaryDirectory })
    const first = await provider.acquire(createRequest("clean-history", false))
    await writeFile(path.join(first.directory, "first.txt"), "first")
    await first.save(saveRequest({ retention: 3 }))
    await first.release()
    const firstIndex = parseWorkspaceIndex((await storage.text("clean-history", "workspace.json"))!)
    const firstRevision = firstIndex.current

    const second = await provider.acquire(createRequest("clean-history", false))
    await expect(stat(path.join(second.directory, "first.txt"))).rejects.toHaveProperty("code", "ENOENT")
    await writeFile(path.join(second.directory, "second.txt"), "second")
    await second.save(saveRequest({ retention: 3 }))
    await second.release()

    const current = await provider.acquire(createRequest("clean-history"))
    await expect(stat(path.join(current.directory, "first.txt"))).rejects.toHaveProperty("code", "ENOENT")
    await expect(readFile(path.join(current.directory, "second.txt"), "utf8")).resolves.toBe("second")
    await current.release()

    const historical = await provider.acquire(
      createRequest("clean-history", {
        exclude: [],
        revision: firstRevision,
      })
    )
    await expect(readFile(path.join(historical.directory, "first.txt"), "utf8")).resolves.toBe("first")
    await historical.release()
  })

  it("prunes archive and folder revisions beyond retention", async () => {
    for (const format of ["archive", "folder"] as const) {
      const temporaryDirectory = await createTemporaryDirectory()
      const storage = new InMemoryWorkspaceStorageAdapter()
      const provider = createPersistentWorkspaceProvider({ format, storage, temporaryDirectory })

      for (let index = 0; index < 3; index += 1) {
        const lease = await provider.acquire(createRequest(`retention-${format}`))
        await writeFile(path.join(lease.directory, "value.txt"), String(index))
        await lease.save(saveRequest({ retention: 2 }))
        await lease.release()
      }

      const workspaceId = `retention-${format}`
      const index = parseWorkspaceIndex((await storage.text(workspaceId, "workspace.json"))!)
      expect(index.revisions).toHaveLength(2)

      if (format === "archive") {
        expect(storage.keys(workspaceId).filter(key => key.endsWith(".tar.gz"))).toHaveLength(2)
      } else {
        const revisionRoots = new Set(
          storage
            .keys(workspaceId)
            .filter(key => key.startsWith("revisions/"))
            .map(key => key.split("/").slice(0, 2).join("/"))
        )
        expect(revisionRoots.size).toBe(2)
      }
    }
  })

  it("applies load include and exclude rules after restoring", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const storage = new InMemoryWorkspaceStorageAdapter()
    const provider = createPersistentWorkspaceProvider({ storage, temporaryDirectory })
    const first = await provider.acquire(createRequest("load-selection", false))
    await mkdir(path.join(first.directory, "src"))
    await writeFile(path.join(first.directory, "src", "keep.ts"), "keep")
    await writeFile(path.join(first.directory, "src", "drop.ts"), "drop")
    await writeFile(path.join(first.directory, "README.md"), "readme")
    await first.save(saveRequest())
    await first.release()

    const second = await provider.acquire(
      createRequest("load-selection", {
        exclude: ["src/drop.ts"],
        include: ["src/**"],
        revision: "current",
      })
    )
    await expect(readFile(path.join(second.directory, "src", "keep.ts"), "utf8")).resolves.toBe("keep")
    await expect(stat(path.join(second.directory, "src", "drop.ts"))).rejects.toHaveProperty("code", "ENOENT")
    await expect(stat(path.join(second.directory, "README.md"))).rejects.toHaveProperty("code", "ENOENT")
    await second.release()
  })

  it("preserves the previous current revision when index publication fails", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const base = new InMemoryWorkspaceStorageAdapter()
    const provider = createPersistentWorkspaceProvider({ storage: base, temporaryDirectory })
    const first = await provider.acquire(createRequest("failed-publication", false))
    await writeFile(path.join(first.directory, "value.txt"), "old")
    await first.save(saveRequest({ retention: 3 }))
    await first.release()
    const oldIndex = await base.text("failed-publication", "workspace.json")

    const failing = createFailingIndexStorage(base)
    const failingProvider = createPersistentWorkspaceProvider({ storage: failing, temporaryDirectory })
    const second = await failingProvider.acquire(createRequest("failed-publication"))
    await writeFile(path.join(second.directory, "value.txt"), "new")
    await expect(second.save(saveRequest({ retention: 3 }))).rejects.toThrow("injected index failure")
    await second.release()

    expect(await base.text("failed-publication", "workspace.json")).toBe(oldIndex)
    expect(base.keys("failed-publication").filter(key => key.endsWith(".tar.gz"))).toHaveLength(1)

    const restored = await provider.acquire(createRequest("failed-publication"))
    await expect(readFile(path.join(restored.directory, "value.txt"), "utf8")).resolves.toBe("old")
    await restored.release()
  })

  it("rejects selected symbolic links without replacing current state", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const storage = new InMemoryWorkspaceStorageAdapter()
    const provider = createPersistentWorkspaceProvider({ storage, temporaryDirectory })
    const first = await provider.acquire(createRequest("links", false))
    await writeFile(path.join(first.directory, "safe.txt"), "safe")
    await first.save(saveRequest())
    await first.release()

    const second = await provider.acquire(createRequest("links"))
    await symlink("safe.txt", path.join(second.directory, "link.txt"))
    await expect(second.save(saveRequest())).rejects.toThrow("symbolic link")
    await second.release()

    const restored = await provider.acquire(createRequest("links"))
    await expect(readFile(path.join(restored.directory, "safe.txt"), "utf8")).resolves.toBe("safe")
    await expect(stat(path.join(restored.directory, "link.txt"))).rejects.toHaveProperty("code", "ENOENT")
    await restored.release()
  })

  it("rejects snapshots that cannot be restored under configured limits", async () => {
    for (const format of ["archive", "folder"] as const) {
      const temporaryDirectory = await createTemporaryDirectory()
      const storage = new InMemoryWorkspaceStorageAdapter()
      const provider = createPersistentWorkspaceProvider({
        format,
        maxEntries: format === "archive" ? 2 : 1,
        storage,
        temporaryDirectory,
      })
      const first = await provider.acquire(createRequest(`limits-${format}`, false))
      await writeFile(path.join(first.directory, "safe.txt"), "safe")
      await first.save(saveRequest())
      await first.release()

      const second = await provider.acquire(createRequest(`limits-${format}`))
      await writeFile(path.join(second.directory, "extra.txt"), "extra")
      await expect(second.save(saveRequest())).rejects.toThrow("snapshot exceeded")
      await second.release()

      const restored = await provider.acquire(createRequest(`limits-${format}`))
      await expect(readFile(path.join(restored.directory, "safe.txt"), "utf8")).resolves.toBe("safe")
      await expect(stat(path.join(restored.directory, "extra.txt"))).rejects.toHaveProperty("code", "ENOENT")
      await restored.release()
    }
  })

  it("passes exclusive Workspace provider conformance", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const storage = new InMemoryWorkspaceStorageAdapter()
    await expect(
      workspaceProviderConformance(createPersistentWorkspaceProvider({ storage, temporaryDirectory }))
    ).resolves.toBeUndefined()
  })
})

function createRequest(
  id: string,
  load:
    | false
    | {
        readonly exclude: readonly string[]
        readonly include?: readonly string[]
        readonly revision: "current" | string
      } = {
    exclude: [],
    revision: "current",
  }
): Readonly<WorkspaceAcquireRequest> {
  return Object.freeze({
    evaluationId: `workspace-persistence-test-${id}`,
    id,
    load,
    save: true,
    signal: new AbortController().signal,
  })
}

function saveRequest(overrides: { readonly retention?: number } = {}) {
  return Object.freeze({
    exclude: Object.freeze([]),
    gitignore: true,
    outcome: "success" as const,
    retention: overrides.retention ?? 1,
    signal: new AbortController().signal,
  })
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aml-workspace-persistence-"))
  temporaryDirectories.push(directory)
  return directory
}

function createFailingIndexStorage(base: InMemoryWorkspaceStorageAdapter): WorkspaceStorageAdapter {
  return {
    name: base.name,
    async acquire(request) {
      const lease = await base.acquire(request)
      let failed = false

      return {
        ...lease,
        async write(objectPath, body, options) {
          if (!failed && objectPath === "workspace.json") {
            failed = true
            throw new Error("injected index failure")
          }

          return await lease.write(objectPath, body, options)
        },
      } satisfies WorkspaceStorageLease
    },
  }
}
