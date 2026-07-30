import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { AmlRuntime, Sandbox, Script, type SandboxAcquireRequest, Workspace } from "@aml-jsx/sdk"
import { DeterministicWorkspaceProvider, sandboxProviderConformance } from "@aml-jsx/sdk/testing"

import { localSandbox } from "../src/index.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async directory => await rm(directory, { force: true, recursive: true }))
  )
})

describe("localSandbox()", () => {
  it("runs Script at the enclosing Workspace cwd and preserves its files", async () => {
    const workspace = await createWorkspace()
    const workspaceProvider = new DeterministicWorkspaceProvider({ directory: workspace })

    await expect(
      new AmlRuntime().evaluate(
        <Workspace cwd="repository" id="script" provider={workspaceProvider} save>
          <Sandbox access="read-write" provider={localSandbox()}>
            <Script shell="node">
              {`import { writeFileSync } from "node:fs"; writeFileSync("script-output.txt", process.cwd())`}
            </Script>
          </Sandbox>
        </Workspace>
      )
    ).resolves.toBe("")

    await expect(readFile(path.join(workspace, "repository", "script-output.txt"), "utf8")).resolves.toBe(
      path.join(workspace, "repository")
    )
    expect(workspaceProvider.saves).toEqual(["deterministic-workspace-1"])
  })

  it("executes through the common runtime in the selected logical cwd", async () => {
    const workspace = await createWorkspace()
    const provider = localSandbox({ workspace })
    const lease = await provider.acquire(request())
    const result = await lease.runtime.exec(
      process.execPath,
      ["-e", "process.stdout.write(`${process.cwd()}|${process.env.AML_FIXTURE}`)"],
      {
        cwd: "repository/src",
        env: { AML_FIXTURE: "local" },
      }
    )

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${path.join(workspace, "repository", "src")}|local`,
    })
    expect(lease.runtime).toMatchObject({
      access: "read-write",
      cwd: "repository",
      root: "repository",
    })
    await lease.release()
  })

  it("keeps PWD aligned with the effective command cwd", async () => {
    const workspace = await createWorkspace()
    const provider = localSandbox({ workspace })
    const lease = await provider.acquire(request())
    const result = await lease.runtime.exec(process.execPath, ["-e", "process.stdout.write(process.env.PWD ?? '')"])

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: path.join(workspace, "repository"),
    })
    await lease.release()
  })

  it("closes stdin because the bounded runtime exposes no input channel", async () => {
    const workspace = await createWorkspace()
    const provider = localSandbox({ workspace })
    const lease = await provider.acquire(request())
    const result = await lease.runtime.exec(process.execPath, [
      "-e",
      "process.stdin.resume();process.stdin.once('end',()=>process.stdout.write('eof'))",
    ])

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "eof",
    })
    await lease.release()
  })

  it("runs explicit setup before returning the lease", async () => {
    const workspace = await createWorkspace()
    const provider = localSandbox({
      setup: "printf setup-complete > setup.txt",
      workspace,
    })
    const lease = await provider.acquire(request())

    await expect(readFile(path.join(workspace, "repository", "setup.txt"), "utf8")).resolves.toBe("setup-complete")
    await lease.release()
  })

  it("surfaces setup failures and rejects read-only execution", async () => {
    const workspace = await createWorkspace()

    await expect(localSandbox({ setup: "printf failed >&2; exit 7", workspace }).acquire(request())).rejects.toThrow(
      "setup failed with exit code 7: failed"
    )

    const lease = await localSandbox({ workspace }).acquire(request({ access: "read-only" }))
    await expect(lease.runtime.exec("pwd")).rejects.toThrow("cannot execute under read-only access")
  })

  it("confines command cwd through real paths", async () => {
    const workspace = await createWorkspace()
    const outside = await mkdtemp(path.join(os.tmpdir(), "aml-local-outside-"))
    temporaryDirectories.push(outside)
    await symlink(outside, path.join(workspace, "repository", "escape"))
    const lease = await localSandbox({ workspace }).acquire(request())

    await expect(lease.runtime.exec("pwd", [], { cwd: "repository/escape" })).rejects.toThrow(
      "command cwd resolves outside"
    )
  })

  it("validates configuration without performing filesystem work", () => {
    expect(() => localSandbox({ maxOutputBytes: 0 })).toThrow("must be a positive safe integer")
    expect(() => localSandbox({ setup: " setup " })).toThrow("setup must be a non-empty normalized string")
  })

  it("passes provider conformance with a configured Workspace", async () => {
    const workspace = await createWorkspace()

    await expect(sandboxProviderConformance(localSandbox({ workspace }))).resolves.toBeUndefined()
  })
})

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "aml-local-sandbox-"))
  temporaryDirectories.push(workspace)
  await mkdir(path.join(workspace, "repository", "src"), { recursive: true })
  await writeFile(path.join(workspace, "repository", "fixture.txt"), "fixture")
  return workspace
}

function request(overrides: Partial<SandboxAcquireRequest> = {}): SandboxAcquireRequest {
  return Object.freeze({
    access: "read-write",
    cwd: "repository",
    evaluationId: "local-test",
    root: "repository",
    signal: new AbortController().signal,
    ...overrides,
  })
}
