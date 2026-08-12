import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"

import { describe, expect, expectTypeOf, it, vi } from "vitest"

import { Agent, AmlRuntime, Sandbox, Script, type ScriptProps, Workspace } from "../src/index.js"
import {
  DeterministicAgentProvider,
  DeterministicSandboxProvider,
  DeterministicWorkspaceProvider,
} from "../src/testing.js"

describe("<Script>", () => {
  it("defines disjoint command and shell forms", () => {
    expectTypeOf<Extract<ScriptProps, { command: string }>["args"]>().toEqualTypeOf<readonly string[] | undefined>()
    expectTypeOf<Extract<ScriptProps, { shell: string }>["children"]>().toEqualTypeOf<ScriptProps["children"]>()

    // @ts-expect-error command form cannot execute child source
    const commandWithChildren: ScriptProps = { children: "git status", command: "git" }
    // @ts-expect-error shell form requires child source
    const shellWithoutChildren: ScriptProps = { shell: "sh" }
    // @ts-expect-error shell form does not accept an argument vector
    const shellWithArgs: ScriptProps = { args: ["status"], children: "git", shell: "sh" }

    expect([commandWithChildren, shellWithoutChildren, shellWithArgs]).toHaveLength(3)
  })

  it("executes on the host from a cwd relative to the runtime cwd", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aml-script-host-"))
    const packageDirectory = join(directory, "packages", "cli")

    try {
      await mkdir(packageDirectory, { recursive: true })
      await expect(
        new AmlRuntime({ cwd: directory }).evaluate(
          <Script command={process.execPath} args={["-e", "process.stdout.write(process.cwd())"]} cwd="packages/cli" />
        )
      ).resolves.toBe(packageDirectory)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("executes Agent-generated source in the active Sandbox and returns stdout", async () => {
    const commands: Array<Readonly<{ args: readonly string[]; command: string; cwd: string | undefined }>> = []
    const workspace = new DeterministicWorkspaceProvider()
    const sandbox = new DeterministicSandboxProvider({
      exec(command, args, _request, options) {
        commands.push({ args, command, cwd: options.cwd })
        return {
          exitCode: 0,
          stderr: "",
          stdout: "generated output",
        }
      },
    })
    const agent = new DeterministicAgentProvider({
      respond: () => ({ text: 'console.log("generated output")' }),
      supportsSandbox: () => true,
    })

    await expect(
      new AmlRuntime({ agentProvider: agent }).evaluate(
        <Workspace cwd="repository" id="script" provider={workspace} save>
          <Sandbox access="read-write" provider={sandbox}>
            <Script cwd="packages/worker" shell="node">
              <Agent>Write the script.</Agent>
            </Script>
          </Sandbox>
        </Workspace>
      )
    ).resolves.toBe("generated output")

    expect(commands).toEqual([
      {
        args: ["--input-type=module", "--eval", 'console.log("generated output")'],
        command: "node",
        cwd: "packages/worker",
      },
    ])
    expect(workspace.saves).toEqual(["deterministic-workspace-1"])
    expect(sandbox.releases).toEqual(["deterministic-sandbox-1"])
  })

  it("executes literal commands without shell interpolation", async () => {
    const execute = vi.fn(() => ({
      exitCode: 0,
      stderr: "",
      stdout: "cloned",
    }))
    const sandbox = new DeterministicSandboxProvider({ exec: execute })

    await expect(
      new AmlRuntime().evaluate(
        <Sandbox access="read-write" provider={sandbox}>
          <Script args={["clone", "https://example.test/repo.git", "."]} command="git" />
        </Sandbox>
      )
    ).resolves.toBe("cloned")

    expect(execute).toHaveBeenCalledWith(
      "git",
      ["clone", "https://example.test/repo.git", "."],
      expect.any(Object),
      expect.objectContaining({ cwd: ".", signal: expect.any(AbortSignal) })
    )
  })

  it("validates execution mode before resolving children", async () => {
    const child = vi.fn(() => "not evaluated")
    const RuntimeScript = Script as unknown as (props: Record<string, unknown>) => never

    function Child() {
      return child()
    }

    await expect(
      new AmlRuntime().evaluate(
        <RuntimeScript command="git" shell="sh">
          <Child />
        </RuntimeScript>
      )
    ).rejects.toThrow("<Script> requires exactly one of command or shell")

    const sandbox = new DeterministicSandboxProvider()
    await expect(
      new AmlRuntime().evaluate(
        <Sandbox provider={sandbox}>
          <RuntimeScript command="git" shell="sh" />
        </Sandbox>
      )
    ).rejects.toThrow("<Script> requires exactly one of command or shell")

    expect(child).not.toHaveBeenCalled()
    expect(sandbox.releases).toEqual(["deterministic-sandbox-1"])
  })

  it("rejects non-portable cwd before resolving children", async () => {
    const child = vi.fn(() => "not evaluated")

    function Child() {
      return child()
    }

    await expect(
      new AmlRuntime().evaluate(
        <Script cwd="../outside" shell="sh">
          <Child />
        </Script>
      )
    ).rejects.toThrow("<Script> cwd cannot contain parent traversal")

    expect(child).not.toHaveBeenCalled()
  })

  it("fails on a non-zero exit and still releases the Sandbox", async () => {
    const sandbox = new DeterministicSandboxProvider({
      exec: () => ({
        exitCode: 7,
        stderr: "build failed",
        stdout: "",
      }),
    })

    await expect(
      new AmlRuntime().evaluate(
        <Sandbox access="read-write" provider={sandbox}>
          <Script shell="sh">exit 7</Script>
        </Sandbox>
      )
    ).rejects.toThrow("<Script> exited with code 7: build failed")

    expect(sandbox.releases).toEqual(["deterministic-sandbox-1"])
  })

  it("rejects execution when a nested Sandbox narrows beyond its runtime", async () => {
    const sandbox = new DeterministicSandboxProvider()

    await expect(
      new AmlRuntime().evaluate(
        <Sandbox access="read-write" provider={sandbox}>
          <Sandbox access="read-only">
            <Script command="pwd" />
          </Sandbox>
        </Sandbox>
      )
    ).rejects.toThrow('Sandbox provider "deterministic-sandbox" does not enforce the effective scope')

    expect(sandbox.releases).toEqual(["deterministic-sandbox-1"])
  })
})
