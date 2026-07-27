import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

const lockState = vi.hoisted(() => ({
  acquire: undefined as
    | ((
        directory: string,
        options: {
          readonly onCompromised: (error: Error) => void
          readonly stale: number
          readonly update: number
        },
      ) => Promise<() => Promise<void>>)
    | undefined,
  options: undefined as
    | {
        readonly onCompromised: (error: Error) => void
        readonly stale: number
        readonly update: number
      }
    | undefined,
  releaseCalls: 0,
}))

vi.mock("proper-lockfile", () => ({
  default: {
    async lock(
      directory: string,
      options: {
        readonly onCompromised: (error: Error) => void
        readonly stale: number
        readonly update: number
      },
    ) {
      lockState.options = options
      return await lockState.acquire?.(directory, options)
    },
  },
}))

import { localWorkspace } from "../src/index.js"

const temporaryDirectories: string[] = []

beforeEach(() => {
  lockState.options = undefined
  lockState.releaseCalls = 0
  lockState.acquire = async () => async () => {
    lockState.releaseCalls += 1
  }
})

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

describe("Local Workspace lock lifecycle", () => {
  it("reports compromise once when save observes it", async () => {
    const lease = await acquireLease()
    const compromise = new Error("heartbeat ownership lost")
    lockState.options?.onCompromised(compromise)
    const saveError = await lease.save().catch((error: unknown) => error)

    expect(saveError).toHaveProperty("cause", compromise)
    expect(saveError).toHaveProperty(
      "message",
      expect.stringContaining("lock was compromised"),
    )
    await expect(lease.release()).resolves.toBeUndefined()
    expect(lockState.releaseCalls).toBe(0)
  })

  it("reports compromise that arrives between save and release", async () => {
    const lease = await acquireLease()
    await lease.save()
    const compromise = new Error("lock stolen after save")
    lockState.options?.onCompromised(compromise)

    await expect(lease.release()).rejects.toHaveProperty(
      "cause",
      compromise,
    )
    expect(lockState.releaseCalls).toBe(0)
  })

  it("attributes compromise and unrelated release failures", async () => {
    const cleanupLease = await acquireLease()
    const compromise = new Error("cleanup lock compromised")
    lockState.options?.onCompromised(compromise)

    await expect(cleanupLease.release()).rejects.toHaveProperty(
      "cause",
      compromise,
    )

    const releaseFailure = new Error("lock directory removal failed")
    lockState.acquire = async () => async () => {
      throw releaseFailure
    }
    const failingLease = await acquireLease()

    await expect(failingLease.release()).rejects.toMatchObject({
      cause: releaseFailure,
      message: expect.stringContaining("lock release failed"),
    })
  })

  it("releases a late lock before preserving cancellation", async () => {
    for (const cleanupFailure of [
      undefined,
      new Error("late lock cleanup failed"),
    ]) {
      let finishLock:
        | ((release: () => Promise<void>) => void)
        | undefined
      let markLockStarted: (() => void) | undefined
      const lockStarted = new Promise<void>((resolve) => {
        markLockStarted = resolve
      })
      lockState.acquire = async () => {
        markLockStarted?.()
        return await new Promise<() => Promise<void>>((resolve) => {
          finishLock = resolve
        })
      }
      const directory = await createTemporaryDirectory()
      const controller = new AbortController()
      const reason = new Error("cancel late local lock")
      const pending = localWorkspace({ directory }).acquire({
        evaluationId: "late-local-lock",
        id: "late-local-lock",
        signal: controller.signal,
      })

      await lockStarted
      controller.abort(reason)
      finishLock?.(async () => {
        lockState.releaseCalls += 1

        if (cleanupFailure !== undefined) {
          throw cleanupFailure
        }
      })
      const error = await pending.catch((cause: unknown) => cause)

      if (cleanupFailure === undefined) {
        expect(error).toBe(reason)
      } else {
        expect(error).toBeInstanceOf(AggregateError)
        expect((error as AggregateError).errors).toEqual([
          reason,
          expect.objectContaining({
            cause: cleanupFailure,
            message: expect.stringContaining("lock release failed"),
          }),
        ])
      }
    }

    expect(lockState.releaseCalls).toBe(2)
  })

  it("attributes compromise during late-cancellation cleanup", async () => {
    let finishLock:
      | ((release: () => Promise<void>) => void)
      | undefined
    let markLockStarted: (() => void) | undefined
    const lockStarted = new Promise<void>((resolve) => {
      markLockStarted = resolve
    })
    lockState.acquire = async () => {
      markLockStarted?.()
      return await new Promise<() => Promise<void>>((resolve) => {
        finishLock = resolve
      })
    }
    const directory = await createTemporaryDirectory()
    const controller = new AbortController()
    const reason = new Error("cancel compromised local lock")
    const compromise = new Error("heartbeat failed while acquiring")
    const pending = localWorkspace({ directory }).acquire({
      evaluationId: "compromised-late-local-lock",
      id: "compromised-late-local-lock",
      signal: controller.signal,
    })

    await lockStarted
    controller.abort(reason)
    lockState.options?.onCompromised(compromise)
    finishLock?.(async () => {
      lockState.releaseCalls += 1
    })
    const error = await pending.catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      reason,
      expect.objectContaining({
        cause: compromise,
        message: expect.stringContaining("lock was compromised"),
      }),
    ])
    expect(lockState.releaseCalls).toBe(0)
  })
})

/**
 * Acquires one real-directory lease through the mocked lock transport.
 */
async function acquireLease() {
  const directory = await createTemporaryDirectory()
  const lease = await localWorkspace({ directory }).acquire({
    evaluationId: "local-lifecycle",
    id: "local-lifecycle",
    signal: new AbortController().signal,
  })

  expect(lockState.options).toMatchObject({
    stale: 30_000,
    update: 10_000,
  })
  return lease
}

/**
 * Creates one existing materialization for lifecycle setup.
 */
async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "aml-local-lifecycle-"),
  )
  temporaryDirectories.push(directory)
  return directory
}
