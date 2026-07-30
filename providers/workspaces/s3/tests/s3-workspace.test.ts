import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { WorkspaceConflictError, type WorkspaceAcquireRequest } from "@aml-jsx/sdk"
import { workspaceProviderConformance } from "@aml-jsx/sdk/testing"

import { s3Workspace } from "../src/index.js"
import { FakeS3Store } from "./fake-s3-client.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

describe("s3Workspace()", () => {
  it("captures and validates its configuration without performing I/O", () => {
    const store = new FakeS3Store()
    const provider = s3Workspace({
      bucket: "aml-workspaces",
      client: store.client,
      prefix: "tests/workspaces",
    })

    expect(provider.name).toBe("s3")
    expect(() => s3Workspace({ bucket: " aml-workspaces", client: store.client })).toThrow(
      "non-empty normalized string"
    )
    expect(() =>
      s3Workspace({
        bucket: "aml-workspaces",
        client: store.client,
        config: {},
      })
    ).toThrow("client or config")
  })

  it("persists a tarball revision and restores it into a fresh materialization", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const store = new FakeS3Store()
    const provider = s3Workspace({
      bucket: "aml-workspaces",
      client: store.client,
      prefix: "round-trip",
      temporaryDirectory,
    })
    const first = await provider.acquire(createRequest("repository"))
    const firstDirectory = first.directory

    await writeFile(path.join(first.directory, "finding.txt"), "persisted finding")
    await first.save()
    await first.release()
    await first.release()
    await expect(stat(firstDirectory)).rejects.toHaveProperty("code", "ENOENT")

    const second = await provider.acquire(createRequest("repository"))

    expect(second.directory).not.toBe(firstDirectory)
    expect(second.handle).toMatchObject({
      format: "archive",
      kind: "persistent-workspace",
      storage: {
        bucket: "aml-workspaces",
        kind: "s3-workspace",
        prefix: "round-trip",
      },
    })
    await expect(readFile(path.join(second.directory, "finding.txt"), "utf8")).resolves.toBe("persisted finding")
    await second.release()

    expect(store.keys().filter(key => key.endsWith("/workspace.json"))).toHaveLength(1)
    expect(store.keys()).toContain("round-trip/repository/workspace.json")
    expect(store.keys().filter(key => key.includes("/revisions/"))).toHaveLength(1)
    expect(store.keys().filter(key => key.endsWith("/lock.json"))).toHaveLength(0)
  })

  it("rejects a competing evaluation until the active Workspace is released", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const store = new FakeS3Store()
    const provider = s3Workspace({
      bucket: "aml-workspaces",
      client: store.client,
      temporaryDirectory,
    })
    const first = await provider.acquire(createRequest("shared"))
    const conflict = await provider.acquire(createRequest("shared")).catch((error: unknown) => error)

    expect(WorkspaceConflictError.is(conflict, "shared")).toBe(true)

    await first.release()
    const second = await provider.acquire(createRequest("shared"))
    await second.release()
  })

  it("allows unlocked evaluations but rejects stale index publication", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const store = new FakeS3Store()
    const provider = s3Workspace({
      bucket: "aml-workspaces",
      client: store.client,
      temporaryDirectory,
    })
    const first = await provider.acquire(createRequest("shared", { lock: false }))
    const second = await provider.acquire(createRequest("shared", { lock: false }))
    await writeFile(path.join(first.directory, "winner.txt"), "first")
    await writeFile(path.join(second.directory, "stale.txt"), "second")

    await first.save()
    await first.release()
    await expect(second.save()).rejects.toThrow("Precondition failed")
    await second.release()

    const restored = await provider.acquire(createRequest("shared"))
    await expect(readFile(path.join(restored.directory, "winner.txt"), "utf8")).resolves.toBe("first")
    await expect(stat(path.join(restored.directory, "stale.txt"))).rejects.toHaveProperty("code", "ENOENT")
    await restored.release()
  })

  it("passes the provider-neutral Workspace conformance suite", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const store = new FakeS3Store()

    await expect(
      workspaceProviderConformance(
        s3Workspace({
          bucket: "aml-workspaces",
          client: store.client,
          temporaryDirectory,
        })
      )
    ).resolves.toBeUndefined()
  })

  it("cannot publish over an index changed since acquisition", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const store = new FakeS3Store()
    const prefix = "stale-writer"
    const workspaceId = "repository"
    const objectRoot = `${prefix}/${workspaceId}`
    const provider = s3Workspace({
      bucket: "aml-workspaces",
      client: store.client,
      prefix,
      temporaryDirectory,
    })
    const lease = await provider.acquire(createRequest(workspaceId))
    await writeFile(path.join(lease.directory, "stale.txt"), "must not publish")
    await store.put(
      `${objectRoot}/workspace.json`,
      JSON.stringify({
        current: "external",
        revisions: [
          {
            createdAt: new Date().toISOString(),
            format: "archive",
            id: "external",
            path: "revisions/external.tar.gz",
          },
        ],
        version: 1,
      })
    )

    await expect(lease.save()).rejects.toThrow("Precondition failed")
    await lease.release()
    expect(store.keys().filter(key => key.includes("/revisions/"))).toHaveLength(0)
  })

  it("preserves cancellation before object or filesystem acquisition", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const store = new FakeS3Store()
    const controller = new AbortController()
    const reason = new Error("cancel S3 Workspace")
    controller.abort(reason)

    await expect(
      s3Workspace({
        bucket: "aml-workspaces",
        client: store.client,
        temporaryDirectory,
      }).acquire(createRequest("cancelled", { signal: controller.signal }))
    ).rejects.toBe(reason)
    expect(store.keys()).toHaveLength(0)
  })

  it("stores and prunes folder revisions through object listing", async () => {
    const temporaryDirectory = await createTemporaryDirectory()
    const store = new FakeS3Store()
    const provider = s3Workspace({
      bucket: "aml-workspaces",
      client: store.client,
      format: "folder",
      prefix: "folder",
      temporaryDirectory,
    })
    const first = await provider.acquire(createRequest("repository"))
    await writeFile(path.join(first.directory, "value.txt"), "first")
    await first.save()
    await writeFile(path.join(first.directory, "value.txt"), "second")
    await first.save()
    await first.release()

    const second = await provider.acquire(createRequest("repository"))
    await expect(readFile(path.join(second.directory, "value.txt"), "utf8")).resolves.toBe("second")
    await second.release()

    expect(store.keys().filter(key => key.endsWith("/manifest.json"))).toHaveLength(1)
    expect(store.keys().filter(key => key.endsWith("/files/value.txt"))).toHaveLength(1)
  })
})

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "aml-workspace-s3-"))
  temporaryDirectories.push(directory)
  return directory
}

function createRequest(
  id: string,
  options: { readonly lock?: boolean; readonly signal?: AbortSignal } = {}
): Readonly<WorkspaceAcquireRequest> {
  return Object.freeze({
    evaluationId: `s3-workspace-test-${id}`,
    id,
    lock: options.lock ?? true,
    signal: options.signal ?? new AbortController().signal,
  })
}
