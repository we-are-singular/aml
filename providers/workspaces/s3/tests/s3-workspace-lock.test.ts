import { afterEach, describe, expect, it, vi } from "vitest"

import { WorkspaceConflictError } from "@aml-jsx/sdk"

import { S3WorkspaceLock } from "../src/s3-workspace-lock.js"
import { FakeS3Store } from "./fake-s3-client.js"

const FIVE_MINUTES = 5 * 60 * 1_000
const TWENTY_MINUTES = 20 * 60 * 1_000
const LOCK_KEY = "tests/workspace/lock.json"

afterEach(() => {
  vi.useRealTimers()
})

describe("S3WorkspaceLock", () => {
  it("rejects another evaluation and removes the lock on release", async () => {
    const store = new FakeS3Store()
    const lock = await S3WorkspaceLock.lock(request(store))
    const conflict = await S3WorkspaceLock.lock(request(store)).catch((error: unknown) => error)

    expect(WorkspaceConflictError.is(conflict, "workspace")).toBe(true)

    await lock.unlock()
    expect(store.keys()).not.toContain(LOCK_KEY)
  })

  it("replaces a lock only after its fixed stale boundary", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:20:01.000Z"))
    const store = new FakeS3Store()
    await store.put(
      LOCK_KEY,
      JSON.stringify({
        token: "abandoned",
        updatedAt: Date.now() - TWENTY_MINUTES - 1,
      })
    )

    const lock = await S3WorkspaceLock.lock(request(store))

    expect(JSON.parse(store.text(LOCK_KEY) ?? "{}")).not.toMatchObject({ token: "abandoned" })
    await lock.unlock()
  })

  it("refreshes a live evaluation without exposing timing options", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    const store = new FakeS3Store()
    const lock = await S3WorkspaceLock.lock(request(store))
    const initial = JSON.parse(store.text(LOCK_KEY) ?? "{}") as { readonly updatedAt: number }

    await vi.advanceTimersByTimeAsync(FIVE_MINUTES)

    const refreshed = JSON.parse(store.text(LOCK_KEY) ?? "{}") as { readonly updatedAt: number }
    expect(refreshed.updatedAt).toBeGreaterThan(initial.updatedAt)
    lock.check()
    await lock.unlock()
  })

  it("does not delete a lock replaced by another owner", async () => {
    vi.useFakeTimers()
    const store = new FakeS3Store()
    const lock = await S3WorkspaceLock.lock(request(store))
    await store.put(
      LOCK_KEY,
      JSON.stringify({
        token: "replacement",
        updatedAt: Date.now(),
      })
    )

    await vi.advanceTimersByTimeAsync(FIVE_MINUTES)

    expect(() => lock.check()).toThrow("lock was lost")
    await expect(lock.unlock()).rejects.toThrow("lock was lost")
    expect(JSON.parse(store.text(LOCK_KEY) ?? "{}")).toMatchObject({ token: "replacement" })
  })
})

function request(store: FakeS3Store) {
  return {
    bucket: "workspaces",
    client: store.client,
    key: LOCK_KEY,
    signal: new AbortController().signal,
    workspaceId: "workspace",
  }
}
