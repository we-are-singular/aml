import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises"
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
    ).rejects.toThrow("<File> requires an enclosing <Workspace>")

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
    ).rejects.toThrow('<File> parent "escape" is not a directory')

    await expect(readFile(path.join(outside, "report.md"), "utf8")).rejects.toHaveProperty("code", "ENOENT")
  })

  it("rejects guest-side writes until Sandboxes expose a portable file API", async () => {
    const directory = await createTemporaryDirectory()
    const sandbox = new DeterministicSandboxProvider()

    await expect(
      new AmlRuntime().evaluate(
        <Workspace provider={workspaceProvider(directory)}>
          <Sandbox provider={sandbox}>
            <File path="report.md">guest write</File>
          </Sandbox>
        </Workspace>
      )
    ).rejects.toThrow("<File> inside <Sandbox> is not supported")

    expect(sandbox.releases).toEqual(["deterministic-sandbox-1"])
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
