import { describe, expect, expectTypeOf, it, vi } from "vitest"

import {
  Agent,
  AmlRuntime,
  defineWorkspaceProvider,
  EvaluationError,
  Sandbox,
  Skill,
  Workspace,
  WorkspaceConflictError,
  type WorkspaceAcquireRequest,
  type WorkspaceLease,
  type WorkspaceMaterializationReference,
  type WorkspaceProvider,
} from "../src/index.js"
import {
  DeterministicSandboxProvider,
  DeterministicWorkspaceProvider,
  workspaceProviderConformance,
} from "../src/testing.js"

describe("<Workspace>", () => {
  it("shares one materialization across sequential Sandboxes before saving", async () => {
    const events: string[] = []
    const state = { revision: 0 }
    let materialization: Readonly<WorkspaceMaterializationReference> | undefined
    const workspaceProvider = new DeterministicWorkspaceProvider({
      createHandle(request) {
        events.push(`workspace:acquire:${request.id}`)
        return state
      },
      release(lease) {
        events.push(`workspace:release:${lease.id}`)
      },
      save(lease) {
        events.push(`workspace:save:${lease.handle.revision}`)
      },
    })
    const sandboxProvider = new DeterministicSandboxProvider({
      createHandle(request, acquisition) {
        events.push(`sandbox:acquire:${acquisition}`)
        expect(request.workspace).toBeDefined()
        materialization ??= request.workspace
        expect(request.workspace).toBe(materialization)
        expect(request.workspace?.handle).toBe(state)
        expect(state.revision).toBe(acquisition)
        state.revision += 1
        return { acquisition }
      },
      release(_lease, acquisition) {
        events.push(`sandbox:release:${acquisition}`)
      },
    })

    await expect(
      new AmlRuntime().evaluate(
        <Workspace id="review-42" provider={workspaceProvider} save>
          <Sandbox provider={sandboxProvider}>first</Sandbox>
          <Sandbox provider={sandboxProvider}>second</Sandbox>
        </Workspace>
      )
    ).resolves.toBe("firstsecond")

    expect(events).toEqual([
      "workspace:acquire:review-42",
      "sandbox:acquire:0",
      "sandbox:release:0",
      "sandbox:acquire:1",
      "sandbox:release:1",
      "workspace:save:2",
      "workspace:release:deterministic-workspace-1",
    ])
    expect(materialization).toMatchObject({
      cwd: ".",
      directory: "/deterministic-workspace",
      leaseId: "deterministic-workspace-1",
      provider: { name: "deterministic-workspace" },
      workspaceId: "review-42",
      writeConcurrency: "serial",
    })
    expect(Object.isFrozen(materialization)).toBe(true)
    expect("save" in (materialization ?? {})).toBe(false)
    expect("release" in (materialization ?? {})).toBe(false)
    expect("acquire" in (materialization?.provider ?? {})).toBe(false)
  })

  it("provides one logical cwd to descendant Sandboxes", async () => {
    const workspaceProvider = new DeterministicWorkspaceProvider()
    const sandboxProvider = new DeterministicSandboxProvider()

    await new AmlRuntime().evaluate(
      <Workspace cwd="repository/src" id="cwd" provider={workspaceProvider}>
        <Sandbox provider={sandboxProvider}>inspect</Sandbox>
      </Workspace>
    )

    expect(sandboxProvider.acquisitions[0]).toMatchObject({
      cwd: "repository/src",
      root: ".",
      workspace: {
        cwd: "repository/src",
        directory: "/deterministic-workspace",
        workspaceId: "cwd",
      },
    })
  })

  it("uses the runtime default and allows durable work without a Sandbox", async () => {
    const provider = new DeterministicWorkspaceProvider()

    await expect(
      new AmlRuntime({
        workspaceProvider: provider,
      }).evaluate(
        <Workspace id="notes" save>
          durable text
        </Workspace>
      )
    ).resolves.toBe("durable text")

    expect(provider.acquisitions[0]).toMatchObject({ id: "notes" })
    expect(provider.saves).toEqual(["deterministic-workspace-1"])
    expect(provider.releases).toEqual(["deterministic-workspace-1"])
  })

  it("defaults to an isolated UUID, current load, and no save", async () => {
    const provider = new DeterministicWorkspaceProvider()

    await new AmlRuntime().evaluate(<Workspace provider={provider}>isolated</Workspace>)

    expect(provider.acquisitions).toHaveLength(1)
    expect(provider.acquisitions[0]).toMatchObject({
      load: {
        exclude: [],
        revision: "current",
      },
      lock: true,
      save: false,
    })
    expect(provider.acquisitions[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(provider.saves).toEqual([])
    expect(provider.releases).toEqual(["deterministic-workspace-1"])
  })

  it("passes normalized load and save policy to the provider", async () => {
    const acquire = vi.fn<WorkspaceProvider["acquire"]>()
    const release = vi.fn(async () => {})
    const save = vi.fn<WorkspaceLease["save"]>(async () => {})
    const provider: WorkspaceProvider = {
      name: "policy-spy",
      acquire,
    }
    acquire.mockResolvedValue({
      directory: "/policy-workspace",
      handle: {},
      id: "policy-lease",
      release,
      save,
    })

    await new AmlRuntime().evaluate(
      <Workspace
        id="policy"
        lock={false}
        load={{
          exclude: ["src/generated/**"],
          include: ["src/**", "README.md"],
          revision: "revision-2",
        }}
        provider={provider}
        save={{
          exclude: ["**/*.tmp"],
          gitignore: false,
          include: ["src/**", "report.md"],
          on: "always",
          retention: 4,
        }}
        writeConcurrency="parallel"
      >
        policy
      </Workspace>
    )

    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "policy",
        lock: false,
        load: {
          exclude: ["src/generated/**"],
          include: ["src/**", "README.md"],
          revision: "revision-2",
        },
        save: true,
      })
    )
    expect(save).toHaveBeenCalledWith({
      exclude: ["**/*.tmp"],
      gitignore: false,
      include: ["src/**", "report.md"],
      outcome: "success",
      retention: 4,
      signal: expect.any(AbortSignal),
    })
    expect(release).toHaveBeenCalledOnce()
  })

  it("rejects invalid placement and more than one declaration", async () => {
    const workspaceProvider = new DeterministicWorkspaceProvider()
    const sandboxProvider = new DeterministicSandboxProvider()

    await expect(
      new AmlRuntime().evaluate(
        <Sandbox provider={sandboxProvider}>
          <Workspace id="inside" provider={workspaceProvider}>
            invalid
          </Workspace>
        </Sandbox>
      )
    ).rejects.toThrow("<Workspace> must be a top-level resource boundary")
    expect(sandboxProvider.releases).toHaveLength(1)
    expect(workspaceProvider.acquisitions).toHaveLength(0)

    await expect(
      new AmlRuntime().evaluate(
        <Agent>
          <Workspace id="agent" provider={workspaceProvider}>
            invalid
          </Workspace>
        </Agent>
      )
    ).rejects.toThrow("<Workspace> must be a top-level resource boundary")

    await expect(
      new AmlRuntime().evaluate(
        <Skill>
          <Workspace id="skill" provider={workspaceProvider}>
            invalid
          </Workspace>
        </Skill>
      )
    ).rejects.toThrow("<Workspace> must be a top-level resource boundary")

    await expect(
      new AmlRuntime().evaluate(
        <Workspace id="outer" provider={workspaceProvider} save={{ on: "always" }}>
          <Workspace id="inner" provider={workspaceProvider}>
            invalid
          </Workspace>
        </Workspace>
      )
    ).rejects.toThrow("An AML evaluation may contain at most one <Workspace>")
    expect(workspaceProvider.saves).toHaveLength(1)
    expect(workspaceProvider.releases).toHaveLength(1)

    await expect(
      new AmlRuntime().evaluate([
        <Workspace id="first" provider={workspaceProvider} save>
          first
        </Workspace>,
        <Workspace id="second" provider={workspaceProvider} save>
          second
        </Workspace>,
      ])
    ).rejects.toThrow("An AML evaluation may contain at most one <Workspace>")
    expect(workspaceProvider.acquisitions).toHaveLength(2)
    expect(workspaceProvider.saves).toHaveLength(2)
    expect(workspaceProvider.releases).toHaveLength(2)
  })

  it("rejects invalid props and providers before descendants", async () => {
    const child = vi.fn(() => "not evaluated")
    const provider = new DeterministicWorkspaceProvider()

    function Child() {
      return child()
    }

    for (const id of ["", " spaced "]) {
      await expect(
        new AmlRuntime().evaluate(
          <Workspace id={id} provider={provider}>
            <Child />
          </Workspace>
        )
      ).rejects.toThrow("<Workspace> id must be a non-empty normalized string")
    }

    for (const cwd of ["", "/absolute", "C:/absolute", "../escape", "packages/../secrets"]) {
      await expect(
        new AmlRuntime().evaluate(
          <Workspace cwd={cwd} id="invalid-cwd" provider={provider}>
            <Child />
          </Workspace>
        )
      ).rejects.toBeInstanceOf(EvaluationError)
    }

    await expect(
      new AmlRuntime().evaluate(
        <Workspace id="missing">
          <Child />
        </Workspace>
      )
    ).rejects.toThrow("<Workspace> requires a provider or AmlRuntime workspaceProvider")

    for (const props of [
      { load: { include: ["!secret"] } },
      { load: { exclude: ["../secret"] } },
      { save: { include: ["/absolute"] } },
      { save: { exclude: ["windows\\path"] } },
      { save: { retention: 0 } },
      { save: { gitignore: "yes" } },
      { save: { on: "sometimes" } },
      { lock: "yes" },
      { writeConcurrency: "sometimes" },
    ]) {
      await expect(
        new AmlRuntime().evaluate(
          <Workspace id="invalid-policy" provider={provider} {...(props as unknown as Record<string, unknown>)}>
            <Child />
          </Workspace>
        )
      ).rejects.toBeInstanceOf(EvaluationError)
    }

    expect(child).not.toHaveBeenCalled()
    expect(provider.acquisitions).toHaveLength(0)
  })

  it("saves partial work after descendant failure and then releases", async () => {
    const failure = new Error("descendant failed")
    const events: string[] = []
    const provider = new DeterministicWorkspaceProvider({
      release() {
        events.push("release")
      },
      save() {
        events.push("save")
      },
    })

    function Fail(): never {
      events.push("child")
      throw failure
    }

    await expect(
      new AmlRuntime().evaluate(
        <Workspace id="failure" provider={provider} save={{ on: "always" }}>
          <Fail />
        </Workspace>
      )
    ).rejects.toBe(failure)
    expect(events).toEqual(["child", "save", "release"])
  })

  it("does not save failed work under the default success policy", async () => {
    const provider = new DeterministicWorkspaceProvider()

    function Fail(): never {
      throw new Error("failed before save")
    }

    await expect(
      new AmlRuntime().evaluate(
        <Workspace id="failure-default" provider={provider} save>
          <Fail />
        </Workspace>
      )
    ).rejects.toThrow("failed before save")
    expect(provider.saves).toEqual([])
    expect(provider.releases).toEqual(["deterministic-workspace-1"])
  })

  it("releases after save failure and preserves both completion failures", async () => {
    const saveFailure = new Error("save failed")
    const releaseFailure = new Error("release failed")
    const provider = new DeterministicWorkspaceProvider({
      release() {
        throw releaseFailure
      },
      save() {
        throw saveFailure
      },
    })

    const error = await new AmlRuntime()
      .evaluate(
        <Workspace id="completion" provider={provider} save>
          resolved
        </Workspace>
      )
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([saveFailure, releaseFailure])
    expect(provider.saves).toHaveLength(1)
    expect(provider.releases).toHaveLength(1)
  })

  it("preserves descendant, Sandbox, save, and release failures", async () => {
    const descendantFailure = new Error("agent failed")
    const sandboxFailure = new Error("sandbox release failed")
    const saveFailure = new Error("save failed")
    const releaseFailure = new Error("workspace release failed")
    const workspaceProvider = new DeterministicWorkspaceProvider({
      release() {
        throw releaseFailure
      },
      save() {
        throw saveFailure
      },
    })
    const sandboxProvider = new DeterministicSandboxProvider({
      release() {
        throw sandboxFailure
      },
    })

    function Fail(): never {
      throw descendantFailure
    }

    const error = await new AmlRuntime()
      .evaluate(
        <Workspace id="causality" provider={workspaceProvider} save={{ on: "always" }}>
          <Sandbox provider={sandboxProvider}>
            <Fail />
          </Sandbox>
        </Workspace>
      )
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AggregateError)
    const topErrors = (error as AggregateError).errors
    expect(topErrors[0]).toBe(descendantFailure)
    expect(topErrors[1]).toHaveProperty("cause", sandboxFailure)
    expect(topErrors[2]).toBeInstanceOf(AggregateError)
    expect((topErrors[2] as AggregateError).errors).toEqual([saveFailure, releaseFailure])
  })

  it("releases without saving when descendant work is cancelled", async () => {
    const controller = new AbortController()
    const reason = new Error("cancel Workspace work")
    const provider = new DeterministicWorkspaceProvider()

    function Cancel() {
      controller.abort(reason)
      return "not rendered"
    }

    await expect(
      new AmlRuntime().evaluate(
        <Workspace id="cancel" provider={provider}>
          <Cancel />
        </Workspace>,
        { signal: controller.signal }
      )
    ).rejects.toBe(reason)
    expect(provider.saves).toEqual([])
    expect(provider.releases).toEqual(["deterministic-workspace-1"])
  })

  it("does not lose cancellation that arrives during final save", async () => {
    const controller = new AbortController()
    const reason = new Error("cancel during Workspace save")
    let finishSave: (() => void) | undefined
    let saveStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      saveStarted = resolve
    })
    const provider = new DeterministicWorkspaceProvider({
      async save() {
        saveStarted?.()
        await new Promise<void>(resolve => {
          finishSave = resolve
        })
      },
    })
    const pending = new AmlRuntime().evaluate(
      <Workspace id="save-cancellation" provider={provider} save>
        resolved
      </Workspace>,
      { signal: controller.signal }
    )

    await started
    controller.abort(reason)
    finishSave?.()

    await expect(pending).rejects.toBe(reason)
    expect(provider.saves).toHaveLength(1)
    expect(provider.releases).toHaveLength(1)
  })

  it("propagates cancellation to cooperative pending acquisition", async () => {
    const controller = new AbortController()
    const reason = new Error("cancel Workspace acquisition")
    let started: (() => void) | undefined
    const acquisitionStarted = new Promise<void>(resolve => {
      started = resolve
    })
    const provider: WorkspaceProvider = {
      name: "cooperative-workspace",
      async acquire(request) {
        started?.()

        return await new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
        })
      },
    }
    const pending = new AmlRuntime().evaluate(
      <Workspace id="pending" provider={provider}>
        never
      </Workspace>,
      { signal: controller.signal }
    )

    await acquisitionStarted
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })

  it("releases a late cancelled acquisition without saving it", async () => {
    const controller = new AbortController()
    const reason = new Error("cancel ignored Workspace acquisition")
    const release = vi.fn(async () => {})
    const save = vi.fn(async () => {})
    let finishAcquisition: ((lease: WorkspaceLease) => void) | undefined
    const provider: WorkspaceProvider = {
      name: "ignores-cancellation",
      async acquire() {
        return await new Promise<WorkspaceLease>(resolve => {
          finishAcquisition = resolve
        })
      },
    }
    const pending = new AmlRuntime().evaluate(
      <Workspace id="late" provider={provider}>
        never
      </Workspace>,
      { signal: controller.signal }
    )

    await vi.waitFor(() => expect(finishAcquisition).toBeTypeOf("function"))
    controller.abort(reason)
    finishAcquisition?.({
      directory: "/late-workspace",
      handle: {},
      id: "late-lease",
      release,
      save,
    })

    await expect(pending).rejects.toBe(reason)
    expect(save).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it("preserves cancellation when a late acquisition returns no cleanup authority", async () => {
    const malformedValues = [
      null,
      Object.defineProperty({}, "release", {
        get() {
          throw new Error("release getter failed")
        },
      }),
    ]

    for (const [index, malformed] of malformedValues.entries()) {
      const controller = new AbortController()
      const reason = new Error(`cancel malformed lease ${index}`)
      let finishAcquisition: ((value: unknown) => void) | undefined
      const provider: WorkspaceProvider = {
        name: `late-malformed-${index}`,
        async acquire() {
          return await new Promise<WorkspaceLease>(resolve => {
            finishAcquisition = resolve as (value: unknown) => void
          })
        },
      }
      const pending = new AmlRuntime().evaluate(
        <Workspace id={`late-malformed-${index}`} provider={provider}>
          never
        </Workspace>,
        { signal: controller.signal }
      )

      await vi.waitFor(() => expect(finishAcquisition).toBeTypeOf("function"))
      controller.abort(reason)
      finishAcquisition?.(malformed)
      const error = await pending.catch((cause: unknown) => cause)

      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors[0]).toBe(reason)
      expect((error as AggregateError).errors[1]).toBeInstanceOf(TypeError)
    }
  })

  it("preserves cancellation raised by later malformed lease accessors", async () => {
    for (const accessor of ["save", "directory"] as const) {
      const controller = new AbortController()
      const reason = new Error(`cancel from ${accessor} accessor`)
      const accessorFailure = new Error(`${accessor} accessor failed`)
      const release = vi.fn(async () => {})
      const lease = {
        directory: "/workspace",
        handle: {},
        id: `lease-${accessor}`,
        release,
        async save() {},
      }

      Object.defineProperty(lease, accessor, {
        get() {
          controller.abort(reason)
          throw accessorFailure
        },
      })

      const provider: WorkspaceProvider = {
        name: `malformed-${accessor}`,
        async acquire() {
          return lease as unknown as WorkspaceLease
        },
      }
      const error = await new AmlRuntime()
        .evaluate(
          <Workspace id={`malformed-${accessor}`} provider={provider}>
            never
          </Workspace>,
          { signal: controller.signal }
        )
        .catch((cause: unknown) => cause)

      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors[0]).toBe(reason)
      expect((error as AggregateError).errors[1]).toHaveProperty("cause", accessorFailure)
      expect(release).toHaveBeenCalledOnce()
    }
  })

  it("preserves cancellation that arrives during malformed-lease cleanup", async () => {
    const releaseFailure = new Error("malformed release failed")

    for (const failure of [undefined, releaseFailure]) {
      const controller = new AbortController()
      const reason = new Error("cancel during malformed release")
      let finishRelease: (() => void) | undefined
      let markReleaseStarted: (() => void) | undefined
      const releaseStarted = new Promise<void>(resolve => {
        markReleaseStarted = resolve
      })
      const provider: WorkspaceProvider = {
        name: "cancel-malformed-cleanup",
        async acquire() {
          return {
            directory: "/workspace",
            handle: {},
            id: " ",
            async release() {
              markReleaseStarted?.()
              await new Promise<void>(resolve => {
                finishRelease = resolve
              })

              if (failure !== undefined) {
                throw failure
              }
            },
            async save() {},
          }
        },
      }
      const pending = new AmlRuntime().evaluate(
        <Workspace id="cancel-cleanup" provider={provider}>
          never
        </Workspace>,
        { signal: controller.signal }
      )

      await releaseStarted
      controller.abort(reason)
      finishRelease?.()
      const error = await pending.catch((cause: unknown) => cause)

      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors[0]).toBe(reason)
      expect((error as AggregateError).errors[1]).toBeInstanceOf(TypeError)

      if (failure !== undefined) {
        expect((error as AggregateError).errors[2]).toBe(failure)
      }
    }
  })

  it("releases malformed leases whenever release is capturable", async () => {
    const releaseForId = vi.fn(async () => {})
    const malformedId: WorkspaceProvider = {
      name: "malformed-id",
      async acquire() {
        return {
          directory: "/workspace",
          handle: {},
          id: " ",
          release: releaseForId,
          async save() {},
        }
      },
    }

    await expect(
      new AmlRuntime().evaluate(
        <Workspace id="malformed" provider={malformedId}>
          never
        </Workspace>
      )
    ).rejects.toThrow("lease with an invalid id")
    expect(releaseForId).toHaveBeenCalledOnce()

    const saveFailure = new Error("save getter failed")
    const releaseForSave = vi.fn(async () => {})
    const lease = {
      directory: "/workspace",
      handle: {},
      id: "lease",
      release: releaseForSave,
    }
    Object.defineProperty(lease, "save", {
      get() {
        throw saveFailure
      },
    })
    const unreadableSave: WorkspaceProvider = {
      name: "unreadable-save",
      async acquire() {
        return lease as unknown as WorkspaceLease
      },
    }
    const error = await new AmlRuntime()
      .evaluate(
        <Workspace id="unreadable" provider={unreadableSave}>
          never
        </Workspace>
      )
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(TypeError)
    expect(error).toHaveProperty("cause", saveFailure)
    expect(releaseForSave).toHaveBeenCalledOnce()
  })

  it("rejects concurrent writers for one durable identity", async () => {
    const provider = new DeterministicWorkspaceProvider()
    let finish: (() => void) | undefined
    let started: (() => void) | undefined
    const childStarted = new Promise<void>(resolve => {
      started = resolve
    })

    async function HoldLease() {
      started?.()
      await new Promise<void>(resolve => {
        finish = resolve
      })
      return "first"
    }

    const first = new AmlRuntime().evaluate(
      <Workspace id="shared" provider={provider}>
        <HoldLease />
      </Workspace>
    )
    await childStarted

    const conflict = await new AmlRuntime()
      .evaluate(
        <Workspace id="shared" provider={provider}>
          second
        </Workspace>
      )
      .catch((cause: unknown) => cause)

    expect(conflict).toBeInstanceOf(EvaluationError)
    expect(conflict).toHaveProperty(
      "cause",
      expect.objectContaining({
        code: "AML_WORKSPACE_CONFLICT",
        message: 'Workspace "shared" already has an active writer',
      })
    )

    finish?.()
    await expect(first).resolves.toBe("first")
  })

  it("rolls back deterministic writer ownership when directory setup fails", async () => {
    const request: WorkspaceAcquireRequest = Object.freeze({
      evaluationId: "directory-recovery",
      id: "recoverable",
      signal: new AbortController().signal,
    })
    const provider = new DeterministicWorkspaceProvider({
      directory(_request, acquisition) {
        if (acquisition === 0) {
          throw new Error("directory setup failed")
        }

        return "/recovered-workspace"
      },
    })

    await expect(provider.acquire(request)).rejects.toThrow("directory setup failed")

    const recovered = await provider.acquire(request)

    expect(recovered.directory).toBe("/recovered-workspace")
    await recovered.release()
  })

  it("rejects providers without an acquisition lock", async () => {
    const releases: string[] = []
    let acquisition = 0
    const provider: WorkspaceProvider = {
      name: "permissive-workspace",
      async acquire() {
        await new Promise<void>(resolve => {
          setTimeout(resolve, 5)
        })
        acquisition += 1
        const id = `permissive-${acquisition}`

        return {
          directory: "/permissive-workspace",
          handle: {},
          id,
          async release() {
            releases.push(id)
          },
          async save() {},
        }
      },
    }

    await expect(workspaceProviderConformance(provider)).rejects.toThrow("allowed concurrent writers")
    expect(releases).toEqual(["permissive-2", "permissive-1"])
  })

  it("propagates non-conflict acquisition failures from conformance", async () => {
    const failure = new Error("storage authentication failed")
    const releases: string[] = []
    let acquisition = 0
    const provider: WorkspaceProvider = {
      name: "failing-conflict-probe",
      async acquire(request) {
        acquisition += 1

        if (acquisition === 2) {
          throw failure
        }

        return {
          directory: "/failing-conflict-probe",
          handle: {},
          id: `lease-${acquisition}`,
          async release() {
            releases.push(request.id)
          },
          async save() {},
        }
      },
    }

    await expect(workspaceProviderConformance(provider)).rejects.toBe(failure)
    expect(releases).toEqual(["conformance-workspace"])
  })

  it("cleans up when conflict-error fields are unreadable", async () => {
    const inspectionFailure = new Error("conflict code unreadable")
    const hostileRejection = Object.defineProperty({}, "code", {
      get() {
        throw inspectionFailure
      },
    })
    const releases: string[] = []
    let acquisition = 0
    const provider: WorkspaceProvider = {
      name: "hostile-conflict-error",
      async acquire(request) {
        acquisition += 1

        if (acquisition === 2) {
          throw hostileRejection
        }

        return {
          directory: "/hostile-conflict-error",
          handle: {},
          id: "hostile-first",
          async release() {
            releases.push(request.id)
          },
          async save() {},
        }
      },
    }
    const error = await workspaceProviderConformance(provider).catch((cause: unknown) => cause)

    expect(error).toBe(hostileRejection)
    expect(WorkspaceConflictError.is(hostileRejection)).toBe(false)
    expect(releases).toEqual(["conformance-workspace"])
  })

  it("reports malformed competing-lease cleanup failures", async () => {
    const cleanupFailure = new Error("competing cleanup failed")
    let acquisition = 0
    const provider: WorkspaceProvider = {
      name: "malformed-competitor",
      async acquire() {
        acquisition += 1

        if (acquisition === 2) {
          return {
            get directory() {
              throw new Error("directory unavailable")
            },
            handle: {},
            id: "malformed",
            async release() {
              throw cleanupFailure
            },
            async save() {},
          } as unknown as WorkspaceLease
        }

        return {
          directory: "/malformed-competitor",
          handle: {},
          id: `lease-${acquisition}`,
          async release() {},
          async save() {},
        }
      },
    }
    const error = await workspaceProviderConformance(provider).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[0]).toHaveProperty(
      "message",
      expect.stringContaining("unreadable materialization")
    )
    expect((error as AggregateError).errors[1]).toBe(cleanupFailure)
  })

  it("does not swallow undefined persistence rejection in conformance", async () => {
    const provider = new DeterministicWorkspaceProvider({
      save() {
        return Promise.reject()
      },
    })
    const outcome = await workspaceProviderConformance(provider).then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({
        error,
        kind: "rejected" as const,
      })
    )

    expect(outcome).toEqual({
      error: undefined,
      kind: "rejected",
    })
    expect(provider.releases).toHaveLength(1)
  })

  it("validates definition and provider-conformance helpers", async () => {
    const provider = new DeterministicWorkspaceProvider()
    const defined = defineWorkspaceProvider(provider)

    expect(defined).toBe(provider)
    expect(Object.isFrozen(defined)).toBe(true)
    expect(WorkspaceConflictError.is(new WorkspaceConflictError("shared"), "shared")).toBe(true)
    await expect(workspaceProviderConformance(new DeterministicWorkspaceProvider())).resolves.toBeUndefined()
    expectTypeOf(defined).toMatchTypeOf<Readonly<WorkspaceProvider>>()
  })
})
