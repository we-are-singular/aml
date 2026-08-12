import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"

import { describe, expect, it, vi } from "vitest"

import { Agent, AmlRuntime, Sandbox, Script, Workspace } from "../src/index.js"
import {
  DeterministicAgentProvider,
  DeterministicSandboxProvider,
  DeterministicWorkspaceProvider,
} from "../src/testing.js"

describe("<Script>", () => {
  it("executes on the host from the runtime cwd when no Sandbox is active", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aml-script-host-"))

    try {
      await expect(
        new AmlRuntime({ cwd: directory }).evaluate(
          <Script command={process.execPath} args={["-e", "process.stdout.write(process.cwd())"]} />
        )
      ).resolves.toBe(directory)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("executes Agent-generated source in the active Sandbox and returns stdout", async () => {
    const commands: Array<Readonly<{ args: readonly string[]; command: string; cwd: string }>> = []
    const workspace = new DeterministicWorkspaceProvider()
    const sandbox = new DeterministicSandboxProvider({
      exec(command, args, request) {
        commands.push({ args, command, cwd: request.cwd })
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
            <Script shell="node">
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
        cwd: "repository",
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
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it("validates execution mode before resolving children", async () => {
    const child = vi.fn(() => "not evaluated")

    function Child() {
      return child()
    }

    await expect(
      new AmlRuntime().evaluate(
        <Script command="git" shell="sh">
          <Child />
        </Script>
      )
    ).rejects.toThrow("<Script> requires exactly one of command or shell")

    const sandbox = new DeterministicSandboxProvider()
    await expect(
      new AmlRuntime().evaluate(
        <Sandbox provider={sandbox}>
          <Script command="git" shell="sh" />
        </Sandbox>
      )
    ).rejects.toThrow("<Script> requires exactly one of command or shell")

    expect(child).not.toHaveBeenCalled()
    expect(sandbox.releases).toEqual(["deterministic-sandbox-1"])
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
