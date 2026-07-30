import { describe, expect, it } from "vitest"

import { SandboxEvaluator } from "../src/components/sandbox/sandbox-evaluator.js"
import type { WorkspaceMaterializationReference } from "../src/components/workspace/workspace-provider.js"
import { DeterministicSandboxProvider } from "../src/testing.js"

describe("Workspace write concurrency", () => {
  it("waits before acquiring a second writable Sandbox in serial mode", async () => {
    const provider = new DeterministicSandboxProvider()
    const evaluator = new SandboxEvaluator(provider)
    const workspace = materialization("serial")
    const first = await evaluator.enter(
      { access: "read-write" },
      undefined,
      workspace,
      "first",
      new AbortController().signal
    )
    const second = evaluator.enter(
      { access: "read-write" },
      undefined,
      workspace,
      "second",
      new AbortController().signal
    )

    await Promise.resolve()
    expect(provider.acquisitions).toHaveLength(1)

    await first.release()
    const acquiredSecond = await second
    expect(provider.acquisitions).toHaveLength(2)
    await acquiredSecond.release()
  })

  it("allows parallel writable Sandboxes when explicitly requested", async () => {
    const provider = new DeterministicSandboxProvider()
    const evaluator = new SandboxEvaluator(provider)
    const workspace = materialization("parallel")
    const [first, second] = await Promise.all([
      evaluator.enter({ access: "read-write" }, undefined, workspace, "first", new AbortController().signal),
      evaluator.enter({ access: "read-write" }, undefined, workspace, "second", new AbortController().signal),
    ])

    expect(provider.acquisitions).toHaveLength(2)
    await Promise.all([first.release(), second.release()])
  })

  it("does not serialize read-only Sandboxes or retain cancelled waiters", async () => {
    const provider = new DeterministicSandboxProvider()
    const evaluator = new SandboxEvaluator(provider)
    const workspace = materialization("serial")
    const [firstRead, secondRead] = await Promise.all([
      evaluator.enter({}, undefined, workspace, "read-1", new AbortController().signal),
      evaluator.enter({}, undefined, workspace, "read-2", new AbortController().signal),
    ])

    expect(provider.acquisitions).toHaveLength(2)
    await Promise.all([firstRead.release(), secondRead.release()])

    const writer = await evaluator.enter(
      { access: "read-write" },
      undefined,
      workspace,
      "writer",
      new AbortController().signal
    )
    const controller = new AbortController()
    const waiting = evaluator.enter({ access: "read-write" }, undefined, workspace, "cancelled", controller.signal)
    const reason = new Error("cancel waiting Sandbox")
    controller.abort(reason)

    await expect(waiting).rejects.toBe(reason)
    await writer.release()

    const next = await evaluator.enter(
      { access: "read-write" },
      undefined,
      workspace,
      "next",
      new AbortController().signal
    )
    await next.release()
  })
})

function materialization(writeConcurrency: "parallel" | "serial"): Readonly<WorkspaceMaterializationReference> {
  return Object.freeze({
    cwd: ".",
    directory: "/workspace",
    handle: {},
    leaseId: "workspace-lease",
    provider: Object.freeze({ name: "workspace" }),
    workspaceId: "workspace",
    writeConcurrency,
  })
}
