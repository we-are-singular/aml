import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { Agent, AmlRuntime, File, Sandbox, Workspace, type WorkspaceProvider } from "../src/index.js"
import { DeterministicAgentProvider, DeterministicSandboxProvider } from "../src/testing.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

describe("<File>", () => {
  it("writes Agent output before a later Agent runs without duplicating file content", async () => {
    const directory = await createTemporaryDirectory()
    let call = 0
    const agent = new DeterministicAgentProvider({
      respond: async () => {
        call += 1

        if (call === 1) {
          return { text: "generated plan" }
        }

        expect(await readFile(path.join(directory, "handoff", "plan.md"), "utf8")).toBe("generated plan")
        return { text: "plan observed" }
      },
    })

    await expect(
      new AmlRuntime({ agentProvider: agent }).evaluate(
        <Workspace id="composition" provider={workspaceProvider(directory)}>
          <File path="handoff/plan.md">
            <Agent>Generate the plan.</Agent>
          </File>
          <Agent>Read handoff/plan.md.</Agent>
        </Workspace>
      )
    ).resolves.toBe("plan observed")

    expect(await readFile(path.join(directory, "handoff", "plan.md"), "utf8")).toBe("generated plan")
    expect(agent.calls).toHaveLength(2)
  })

  it("validates placement and path before resolving children", async () => {
    const child = vi.fn(() => "not evaluated")

    function Child() {
      return child()
    }

    await expect(
      new AmlRuntime().evaluate(
        <File path="../outside.txt">
          <Child />
        </File>
      )
    ).rejects.toThrow("<File> requires an enclosing <Workspace> or <Sandbox>")

    const directory = await createTemporaryDirectory()
    await expect(
      new AmlRuntime().evaluate(
        <Workspace provider={workspaceProvider(directory)}>
          <File path="../outside.txt">
            <Child />
          </File>
        </Workspace>
      )
    ).rejects.toThrow("<File> path cannot contain parent traversal")

    expect(child).not.toHaveBeenCalled()
  })

  it("rejects a symbolic-link parent without writing outside the Workspace", async () => {
    const directory = await createTemporaryDirectory()
    const outside = await createTemporaryDirectory()
    await symlink(outside, path.join(directory, "escape"))

    await expect(
      new AmlRuntime().evaluate(
        <Workspace provider={workspaceProvider(directory)}>
          <File path="escape/report.md">blocked</File>
        </Workspace>
      )
    ).rejects.toThrow('<File> could not write "escape/report.md"')

    await expect(readFile(path.join(outside, "report.md"), "utf8")).rejects.toHaveProperty("code", "ENOENT")
  })

  it("writes the live guest filesystem inside a read-write Sandbox", async () => {
    const sandbox = new DeterministicSandboxProvider()
    const agent = new DeterministicAgentProvider({
      async respond(_request, context) {
        const content = await context.sandbox?.lease.runtime.readFile("report.md")
        expect(new TextDecoder().decode(content)).toBe("guest write")
        return { text: "observed" }
      },
      supportsSandbox: () => true,
    })

    await expect(
      new AmlRuntime().evaluate(
        <Sandbox access="read-write" provider={sandbox}>
          <File path="report.md">guest write</File>
          <Agent provider={agent}>Inspect report.md.</Agent>
        </Sandbox>
      )
    ).resolves.toBe("observed")

    expect(sandbox.releases).toEqual(["deterministic-sandbox-1"])
  })

  it("copies a local UTF-8 src into the nearest filesystem", async () => {
    const application = await createTemporaryDirectory()
    const workspace = await createTemporaryDirectory()
    await writeFile(path.join(application, "policy.md"), "local policy")

    await expect(
      new AmlRuntime({ cwd: application }).evaluate(
        <Workspace provider={workspaceProvider(workspace)}>
          <File path="context/policy.md" src="./policy.md" />
        </Workspace>
      )
    ).resolves.toBe("")
    expect(await readFile(path.join(workspace, "context/policy.md"), "utf8")).toBe("local policy")
  })

  it("rejects writes inside a read-only Sandbox", async () => {
    const sandbox = new DeterministicSandboxProvider()

    await expect(
      new AmlRuntime().evaluate(
        <Sandbox access="read-only" provider={sandbox}>
          <File path="report.md">blocked</File>
        </Sandbox>
      )
    ).rejects.toThrow("<File> cannot write inside a read-only <Sandbox>")
    expect(sandbox.releases).toEqual(["deterministic-sandbox-1"])
  })

  it("rejects ambiguous, missing, non-file, and non-UTF-8 local sources", async () => {
    const application = await createTemporaryDirectory()
    const workspace = await createTemporaryDirectory()
    await mkdir(path.join(application, "folder"))
    await writeFile(path.join(application, "binary"), new Uint8Array([0xff]))
    const UnsafeFile = File as unknown as (props: Record<string, unknown>) => never
    const runtime = new AmlRuntime({ cwd: application, workspaceProvider: workspaceProvider(workspace) })

    await expect(
      runtime.evaluate(
        <Workspace>
          <UnsafeFile path="missing-source.txt" />
        </Workspace>
      )
    ).rejects.toThrow("requires exactly one of src or children")
    await expect(
      runtime.evaluate(
        <Workspace>
          <UnsafeFile path="ambiguous.txt" src="./binary">
            children
          </UnsafeFile>
        </Workspace>
      )
    ).rejects.toThrow("requires exactly one of src or children")
    await expect(
      runtime.evaluate(
        <Workspace>
          <File path="folder.txt" src="./folder" />
        </Workspace>
      )
    ).rejects.toThrow("src must identify a regular file")
    await expect(
      runtime.evaluate(
        <Workspace>
          <File path="binary.txt" src="./binary" />
        </Workspace>
      )
    ).rejects.toThrow("could not read local source")
  })
})

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aml-file-test-"))
  temporaryDirectories.push(directory)
  return directory
}

function workspaceProvider(directory: string): WorkspaceProvider {
  return {
    name: "file-test",
    async acquire(request) {
      await mkdir(directory, { recursive: true })

      return {
        directory,
        handle: {},
        id: request.id,
        async release() {},
        async save() {},
      }
    },
  }
}
