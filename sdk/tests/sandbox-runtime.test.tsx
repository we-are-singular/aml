import { describe, expect, expectTypeOf, it, vi } from "vitest"

import {
  Agent,
  AmlRuntime,
  defineSandboxProvider,
  EvaluationError,
  Sandbox,
  type SandboxLease,
  type SandboxProvider,
  type SandboxRuntime,
} from "../src/index.js"
import { DeterministicAgentProvider, DeterministicSandboxProvider, sandboxProviderConformance } from "../src/testing.js"

const fixtureRuntime: Readonly<SandboxRuntime> = Object.freeze({
  access: "read-only",
  async createFileStaging() {
    return Object.freeze({
      async release() {},
      root: "/tmp/fixture-staging",
      async writeFile() {},
    })
  },
  cwd: ".",
  async exec() {
    return { exitCode: 0, stderr: "", stdout: "" }
  },
  async readFile() {
    return new Uint8Array()
  },
  root: ".",
  async spawn() {
    return {
      id: "fixture-process",
      async kill() {},
      stdin: new WritableStream(),
      stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
      stdout: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
      async wait() {
        return { exitCode: 0 }
      },
    }
  },
  async stat() {
    return Object.freeze({ kind: "file" as const, size: 0 })
  },
  async writeFile() {},
})

describe("<Sandbox>", () => {
  it("acquires before descendants and releases after the complete subtree", async () => {
    const events: string[] = []
    const sandboxProvider = new DeterministicSandboxProvider({
      createHandle(request) {
        events.push(`acquire:${request.cwd}`)
        return { environment: "fixture" as const }
      },
      release(lease) {
        events.push(`release:${lease.id}`)
      },
    })
    const agentProvider = new DeterministicAgentProvider({
      respond(_request, context) {
        events.push(`agent:${context.sandbox?.lease.id}`)
        return { text: "done" }
      },
      supportsSandbox: () => true,
    })

    await expect(
      new AmlRuntime({ agentProvider }).evaluate(
        <Sandbox access="read-write" cwd="src" provider={sandboxProvider} root="repository">
          <Agent>Inspect.</Agent>
        </Sandbox>
      )
    ).resolves.toBe("done")

    expect(events).toEqual([
      "acquire:repository/src",
      "agent:deterministic-sandbox-1",
      "release:deterministic-sandbox-1",
    ])
    expect(sandboxProvider.acquisitions).toEqual([
      expect.objectContaining({
        access: "read-write",
        cwd: "repository/src",
        root: "repository",
      }),
    ])
    expect(sandboxProvider.releases).toEqual(["deterministic-sandbox-1"])
    expect("release" in (agentProvider.calls[0]?.context.sandbox?.lease ?? {})).toBe(false)
    expect("acquire" in (agentProvider.calls[0]?.context.sandbox?.provider ?? {})).toBe(false)
  })

  it("uses the runtime default and applies root defaults", async () => {
    const sandboxProvider = new DeterministicSandboxProvider()
    const agentProvider = new DeterministicAgentProvider({
      supportsSandbox: () => true,
    })

    await new AmlRuntime({
      agentProvider,
      sandboxProvider,
    }).evaluate(
      <Sandbox>
        <Agent>Inspect.</Agent>
      </Sandbox>
    )

    expect(sandboxProvider.acquisitions).toEqual([
      expect.objectContaining({
        access: "read-only",
        cwd: ".",
        root: ".",
      }),
    ])
  })

  it("shares one lease across nested restrictive views", async () => {
    const sandboxProvider = new DeterministicSandboxProvider()
    const agentProvider = new DeterministicAgentProvider({
      supportsSandbox: () => true,
    })

    await new AmlRuntime({ agentProvider }).evaluate(
      <Sandbox access="read-write" provider={sandboxProvider} root="repository">
        <Sandbox access="read-only" cwd="src" root="packages/api">
          <Agent cwd="routes">Inspect routes.</Agent>
        </Sandbox>
      </Sandbox>
    )

    expect(sandboxProvider.acquisitions).toHaveLength(1)
    expect(sandboxProvider.releases).toHaveLength(1)
    expect(agentProvider.calls[0]?.context.sandbox).toMatchObject({
      access: "read-only",
      cwd: "repository/packages/api/routes",
      nested: true,
      root: "repository/packages/api",
    })
    expect(agentProvider.calls[0]?.context.sandbox?.lease).toBeDefined()
    expect(agentProvider.calls[0]?.context.trace.parentSpanId).toBe("span-2")
  })

  it("rejects nested permission widening and provider replacement", async () => {
    const sandboxProvider = new DeterministicSandboxProvider()
    const replacement = new DeterministicSandboxProvider({
      name: "replacement",
    })
    const runtime = new AmlRuntime()

    await expect(
      runtime.evaluate(
        <Sandbox provider={sandboxProvider}>
          <Sandbox access="read-write">invalid</Sandbox>
        </Sandbox>
      )
    ).rejects.toThrow("A nested <Sandbox> cannot widen read-only access to read-write")
    await expect(
      runtime.evaluate(
        <Sandbox provider={sandboxProvider}>
          <Sandbox provider={replacement}>invalid</Sandbox>
        </Sandbox>
      )
    ).rejects.toThrow("A nested <Sandbox> cannot select a provider")

    // Each invalid nested scope is discovered after its outer lease exists.
    expect(sandboxProvider.acquisitions).toHaveLength(2)
    expect(sandboxProvider.releases).toHaveLength(2)
    expect(replacement.acquisitions).toHaveLength(0)
  })

  it("rejects invalid paths before root acquisition and cleans nested failures", async () => {
    const sandboxProvider = new DeterministicSandboxProvider()
    const runtime = new AmlRuntime()

    for (const root of ["", "/absolute", "C:/absolute", "../escape", "packages/../secrets"]) {
      await expect(
        runtime.evaluate(
          <Sandbox provider={sandboxProvider} root={root}>
            invalid
          </Sandbox>
        )
      ).rejects.toBeInstanceOf(EvaluationError)
    }

    expect(sandboxProvider.acquisitions).toHaveLength(0)

    await expect(
      runtime.evaluate(
        <Sandbox cwd="src/../secrets" provider={sandboxProvider} root="repository">
          invalid
        </Sandbox>
      )
    ).rejects.toThrow("cannot contain parent traversal")
    expect(sandboxProvider.acquisitions).toHaveLength(0)

    await expect(
      runtime.evaluate(
        <Sandbox provider={sandboxProvider} root="repository">
          <Sandbox root="../../escape">invalid</Sandbox>
        </Sandbox>
      )
    ).rejects.toThrow("cannot contain parent traversal")
    expect(sandboxProvider.releases).toHaveLength(1)

    await expect(
      runtime.evaluate(
        <Sandbox provider={sandboxProvider} root="repository">
          <Sandbox cwd="src/../secrets">invalid</Sandbox>
        </Sandbox>
      )
    ).rejects.toThrow("cannot contain parent traversal")
    expect(sandboxProvider.releases).toHaveLength(2)
  })

  it("requires Agent cwd overrides to remain inside a Sandbox root", async () => {
    const agentProvider = new DeterministicAgentProvider({
      supportsSandbox: () => true,
    })
    const runtime = new AmlRuntime({ agentProvider })

    await expect(runtime.evaluate(<Agent cwd="src">Inspect.</Agent>)).rejects.toThrow(
      "<Agent> cwd requires an enclosing <Sandbox>"
    )

    const sandboxProvider = new DeterministicSandboxProvider()
    await expect(
      runtime.evaluate(
        <Sandbox provider={sandboxProvider}>
          <Agent cwd="src/../escape">Inspect.</Agent>
        </Sandbox>
      )
    ).rejects.toThrow("cannot contain parent traversal")
    expect(agentProvider.calls).toHaveLength(0)
    expect(sandboxProvider.releases).toHaveLength(1)
  })

  it("rejects missing providers and invalid access before descendants", async () => {
    const child = vi.fn(() => "not evaluated")

    function Child() {
      return child()
    }

    await expect(
      new AmlRuntime().evaluate(
        <Sandbox>
          <Child />
        </Sandbox>
      )
    ).rejects.toThrow("<Sandbox> requires a provider or AmlRuntime sandboxProvider")

    const sandboxProvider = new DeterministicSandboxProvider()
    await expect(
      new AmlRuntime().evaluate(
        <Sandbox access={"execute" as "read-only"} provider={sandboxProvider}>
          <Child />
        </Sandbox>
      )
    ).rejects.toThrow('<Sandbox> access must be "read-only" or "read-write"')

    expect(child).not.toHaveBeenCalled()
    expect(sandboxProvider.acquisitions).toHaveLength(0)
  })

  it("requires an explicit Agent-provider compatibility handshake", async () => {
    const sandboxProvider = new DeterministicSandboxProvider()
    const unsupported = new DeterministicAgentProvider()
    const runtime = new AmlRuntime({ agentProvider: unsupported })

    await expect(
      runtime.evaluate(
        <Sandbox provider={sandboxProvider}>
          <Agent>Inspect.</Agent>
        </Sandbox>
      )
    ).rejects.toThrow('Agent provider "deterministic" cannot run inside Sandbox provider "deterministic-sandbox"')

    expect(unsupported.calls).toHaveLength(0)
    expect(sandboxProvider.releases).toHaveLength(1)
  })

  it("attributes compatibility-check failures and still releases", async () => {
    const failure = new Error("compatibility exploded")
    const sandboxProvider = new DeterministicSandboxProvider()
    const agentProvider = new DeterministicAgentProvider({
      supportsSandbox() {
        throw failure
      },
    })

    const error = await new AmlRuntime({ agentProvider })
      .evaluate(
        <Sandbox provider={sandboxProvider}>
          <Agent>Inspect.</Agent>
        </Sandbox>
      )
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(EvaluationError)
    expect(error).toHaveProperty("cause", failure)
    expect(sandboxProvider.releases).toHaveLength(1)
  })

  it("releases after descendant failure and preserves cleanup causality", async () => {
    const agentFailure = new Error("agent failed")
    const releaseFailure = new Error("release failed")
    const sandboxProvider = new DeterministicSandboxProvider({
      release() {
        throw releaseFailure
      },
    })
    const agentProvider = new DeterministicAgentProvider({
      respond() {
        throw agentFailure
      },
      supportsSandbox: () => true,
    })

    const error = await new AmlRuntime({ agentProvider })
      .evaluate(
        <Sandbox provider={sandboxProvider}>
          <Agent>Inspect.</Agent>
        </Sandbox>
      )
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(2)
    expect((error as AggregateError).errors[0]).toHaveProperty("cause", agentFailure)
    expect((error as AggregateError).errors[1]).toHaveProperty("cause", releaseFailure)
    expect(sandboxProvider.releases).toHaveLength(1)
  })

  it("releases once when evaluation is cancelled inside the scope", async () => {
    const controller = new AbortController()
    const reason = new Error("stop sandbox work")
    const sandboxProvider = new DeterministicSandboxProvider()

    function CancelEvaluation() {
      controller.abort(reason)
      return "not rendered"
    }

    await expect(
      new AmlRuntime().evaluate(
        <Sandbox provider={sandboxProvider}>
          <CancelEvaluation />
        </Sandbox>,
        { signal: controller.signal }
      )
    ).rejects.toBe(reason)
    expect(sandboxProvider.releases).toEqual(["deterministic-sandbox-1"])
  })

  it("propagates cancellation to a pending cooperative acquisition", async () => {
    const controller = new AbortController()
    const reason = new Error("cancel pending acquisition")
    let cleanedPartialSetup = false
    let started: (() => void) | undefined
    const acquisitionStarted = new Promise<void>(resolve => {
      started = resolve
    })
    const provider: SandboxProvider = {
      name: "cooperative",
      async acquire(request) {
        started?.()

        return await new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => {
              cleanedPartialSetup = true
              reject(request.signal.reason)
            },
            { once: true }
          )
        })
      },
    }
    const pending = new AmlRuntime().evaluate(<Sandbox provider={provider}>never</Sandbox>, {
      signal: controller.signal,
    })

    await acquisitionStarted
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(cleanedPartialSetup).toBe(true)
  })

  it("releases a late lease before surfacing cancellation", async () => {
    const controller = new AbortController()
    const reason = new Error("cancel ignored acquisition")
    const release = vi.fn(async () => {})
    let finishAcquisition: ((lease: SandboxLease) => void) | undefined
    const provider: SandboxProvider = {
      name: "ignores-cancellation",
      async acquire(request) {
        return await new Promise<SandboxLease>(resolve => {
          finishAcquisition = resolve
          expect(request.signal).toBe(controller.signal)
        })
      },
    }
    const pending = new AmlRuntime().evaluate(<Sandbox provider={provider}>never</Sandbox>, {
      signal: controller.signal,
    })

    await vi.waitFor(() => expect(finishAcquisition).toBeTypeOf("function"))
    controller.abort(reason)
    finishAcquisition?.({
      handle: {},
      id: "late-lease",
      release,
      runtime: fixtureRuntime,
    })

    await expect(pending).rejects.toBe(reason)
    expect(release).toHaveBeenCalledOnce()
  })

  it("preserves cancellation and a concurrent release failure", async () => {
    const controller = new AbortController()
    const cancellation = new Error("cancel during release")
    const releaseFailure = new Error("release after cancellation failed")
    let failRelease: ((error: Error) => void) | undefined
    let releaseStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      releaseStarted = resolve
    })
    const sandboxProvider = new DeterministicSandboxProvider({
      async release() {
        releaseStarted?.()
        await new Promise<void>((_resolve, reject) => {
          failRelease = reject
        })
      },
    })
    const pending = new AmlRuntime().evaluate(<Sandbox provider={sandboxProvider}>resolved</Sandbox>, {
      signal: controller.signal,
    })

    await started
    controller.abort(cancellation)
    failRelease?.(releaseFailure)

    const error = await pending.catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([cancellation, expect.objectContaining({ cause: releaseFailure })])
    expect(sandboxProvider.releases).toHaveLength(1)
  })

  it("attributes acquisition failures without evaluating descendants", async () => {
    const failure = new Error("acquire failed")
    const child = vi.fn(() => "not evaluated")
    const provider: SandboxProvider = {
      name: "broken",
      async acquire() {
        throw failure
      },
    }

    function Child() {
      return child()
    }

    const error = await new AmlRuntime()
      .evaluate(
        <Sandbox provider={provider}>
          <Child />
        </Sandbox>
      )
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(EvaluationError)
    expect(error).toHaveProperty("cause", failure)
    expect(child).not.toHaveBeenCalled()
  })

  it("releases a malformed lease when cleanup remains callable", async () => {
    const release = vi.fn(async () => {})
    const provider: SandboxProvider = {
      name: "malformed",
      async acquire() {
        return {
          handle: {},
          id: " ",
          release,
          runtime: fixtureRuntime,
        } as SandboxLease
      },
    }

    await expect(new AmlRuntime().evaluate(<Sandbox provider={provider}>never</Sandbox>)).rejects.toThrow(
      "lease with an invalid id"
    )
    expect(release).toHaveBeenCalledOnce()
  })

  it("attributes throwing lease accessors and cleans capturable leases", async () => {
    for (const field of ["handle", "id"] as const) {
      const failure = new Error(`${field} getter failed`)
      const release = vi.fn(async () => {})
      const lease = {
        handle: {},
        id: "lease",
        release,
        runtime: fixtureRuntime,
      }

      Object.defineProperty(lease, field, {
        get() {
          throw failure
        },
      })

      const provider: SandboxProvider = {
        name: `throwing-${field}`,
        async acquire() {
          return lease as SandboxLease
        },
      }
      const error = await new AmlRuntime()
        .evaluate(<Sandbox provider={provider}>never</Sandbox>)
        .catch((cause: unknown) => cause)

      expect(error).toBeInstanceOf(TypeError)
      expect(error).toHaveProperty("cause", failure)
      expect(error).toHaveProperty(
        "message",
        `Sandbox provider "throwing-${field}" returned a lease with unreadable identity data`
      )
      expect(release).toHaveBeenCalledOnce()
    }
  })

  it("attributes an unreadable release method when cleanup is impossible", async () => {
    const failure = new Error("release getter failed")
    const lease = {
      handle: {},
      id: "lease",
      runtime: fixtureRuntime,
    }

    Object.defineProperty(lease, "release", {
      get() {
        throw failure
      },
    })

    const provider: SandboxProvider = {
      name: "throwing-release",
      async acquire() {
        return lease as SandboxLease
      },
    }
    const error = await new AmlRuntime()
      .evaluate(<Sandbox provider={provider}>never</Sandbox>)
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(TypeError)
    expect(error).toHaveProperty("cause", failure)
    expect(error).toHaveProperty(
      "message",
      'Sandbox provider "throwing-release" returned a lease with an unreadable release method'
    )
  })

  it("captures Sandbox-provider identity exactly once", async () => {
    let nameReads = 0
    const provider: SandboxProvider = {
      get name() {
        nameReads += 1
        return nameReads === 1 ? "captured-name" : "mutated-name"
      },
      async acquire() {
        return {
          handle: {},
          id: "lease",
          async release() {},
          runtime: fixtureRuntime,
        }
      },
    }
    const unsupported = new DeterministicAgentProvider()

    await expect(
      new AmlRuntime({ agentProvider: unsupported }).evaluate(
        <Sandbox provider={provider}>
          <Agent>Inspect.</Agent>
        </Sandbox>
      )
    ).rejects.toThrow('cannot run inside Sandbox provider "captured-name"')
    expect(nameReads).toBe(1)
  })
})

describe("Sandbox provider authorship", () => {
  it("preserves provider inference and validates stable identity", () => {
    const provider = defineSandboxProvider({
      name: "literal-sandbox",
      async acquire() {
        return {
          handle: { literal: true as const },
          id: "lease",
          async release() {},
          runtime: fixtureRuntime,
        }
      },
    })

    expectTypeOf(provider.name).toEqualTypeOf<"literal-sandbox">()
    expect(Object.isFrozen(provider)).toBe(true)
    expect(() =>
      defineSandboxProvider({
        name: " invalid ",
        async acquire() {
          throw new Error("not called")
        },
      })
    ).toThrow("must already be normalized")
  })

  it("passes the reusable conformance lifecycle", async () => {
    const provider = new DeterministicSandboxProvider()

    await expect(sandboxProviderConformance(provider)).resolves.toBeUndefined()
    expect(provider.acquisitions).toHaveLength(1)
    expect(provider.releases).toEqual(["deterministic-sandbox-1"])
  })
})
