import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { kill, platform } from "node:process"
import { clearTimeout, setTimeout } from "node:timers"
import { setTimeout as delay } from "node:timers/promises"
import { URL } from "node:url"

import { describe, expect, it } from "vitest"

import { runCli, spawnCli } from "./helpers/run-cli.js"

const repositoryRoot = resolve(import.meta.dirname, "../../..")
const fixtures = resolve(import.meta.dirname, "fixtures")
const packageManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Readonly<{
  version: string
}>

function expectSuccess(result: ReturnType<typeof runCli>): void {
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status).toBe(0)
}

describe("compiled aml command", () => {
  it("prints root help when invoked without a command", () => {
    const result = runCli([])

    expectSuccess(result)
    expect(result.stdout).toContain("run <workflowFile>")
    expect(result.stderr).toBe("")
  })

  it("reports the package version and generated help", () => {
    const version = runCli(["--version"])
    const help = runCli(["run", "--help"])

    expectSuccess(version)
    const [identifier, platform, nodeVersion] = version.stdout.trim().split(" ")
    expect(identifier).toBe(`aml/${packageManifest.version}`)
    expect(platform).toMatch(/^\S+$/)
    expect(nodeVersion).toMatch(/^node-v\S+$/)
    expect(version.stderr).toBe("")
    expectSuccess(help)
    expect(help.stdout).toContain("aml run <workflowFile>")
    expect(help.stdout).toContain("--runtime-env-file")
  })

  it("executes a maintained repository TSX workflow", () => {
    const result = runCli(["run", resolve(repositoryRoot, "examples/src/core/basic.tsx")], {
      cwd: repositoryRoot,
    })

    expectSuccess(result)
    expect(result.stdout).toBe("AML resolves bottom-up\n")
    expect(result.stderr).toContain("aml: starting run")
    expect(result.stderr).toContain("(ok)")
  })

  it("supports absolute workflow paths containing spaces", () => {
    const result = runCli(["run", resolve(fixtures, "path with spaces/workflow.tsx")], {
      cwd: repositoryRoot,
    })

    expectSuccess(result)
    expect(result.stdout).toBe("path with spaces\n")
  })

  it("supports main and explicit async named exports", () => {
    const main = runCli(["run", resolve(fixtures, "main.ts")], { cwd: repositoryRoot })
    const named = runCli(["run", resolve(fixtures, "exports.ts"), "--entry", "alternate"], {
      cwd: repositoryRoot,
    })

    expectSuccess(main)
    expect(main.stdout).toBe("main result\n")
    expectSuccess(named)
    expect(named.stdout).toBe("named result\n")
  })

  it("executes JavaScript workflows through the same Vite loader", () => {
    const result = runCli(["run", resolve(fixtures, "javascript.js")], {
      cwd: repositoryRoot,
    })

    expectSuccess(result)
    expect(result.stdout).toBe("javascript result\n")
  })

  it("emits a machine-readable success envelope without diagnostics on stdout", () => {
    const result = runCli(["run", resolve(fixtures, "exports.ts"), "--json"], {
      cwd: repositoryRoot,
    })

    expectSuccess(result)
    expect(JSON.parse(result.stdout)).toMatchObject({
      result: "default result",
      success: true,
    })
    expect(result.stderr).toContain("aml: starting run")
  })

  it("loads workflow env before module evaluation and applies explicit overrides last", () => {
    const workflow = resolve(fixtures, "env/workflow.tsx")
    const ambient = runCli(["run", workflow], {
      cwd: repositoryRoot,
      env: { CLI_TEST_SHARED: "from-process", NODE_ENV: "dev" },
    })
    const overridden = runCli(["run", workflow, "--runtime-env-file", ".env.custom"], {
      cwd: repositoryRoot,
      env: { CLI_TEST_SHARED: "from-process", NODE_ENV: "dev" },
    })

    expectSuccess(ambient)
    expect(ambient.stdout).toBe("from-process|from-dotenv-dev|from-dotenv\n")
    expectSuccess(overridden)
    expect(overridden.stdout).toBe("from-custom|from-dotenv-dev|from-env-file\n")
  })

  it("runs a deterministic Agent and keeps trace diagnostics on stderr", () => {
    const workflow = resolve(fixtures, "agent.tsx")
    const result = runCli(["run", workflow, "--trace"], { cwd: repositoryRoot })

    expectSuccess(result)
    expect(result.stdout).toBe("answer:trace fixture prompt\n")
    expect(result.stderr).toContain("aml: starting run")
    expect(result.stderr).toContain("agent")
    expect(result.stderr).not.toContain("trace fixture prompt")
  })

  it("prints the provider cause when an Agent fails", () => {
    const result = runCli(["run", resolve(fixtures, "agent-error.tsx")], { cwd: repositoryRoot })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain('Agent "broken-provider" (span-1) failed')
    expect(result.stderr).toContain("caused by: provider stderr: model request failed")
  })

  // Windows child.kill() terminates the process directly instead of delivering
  // a catchable POSIX signal, so it cannot exercise graceful CLI cancellation.
  it.skipIf(platform === "win32").each([
    { exitCode: 130, signal: "SIGINT" as const },
    { exitCode: 143, signal: "SIGTERM" as const },
  ])(
    "turns $signal into runtime cancellation and reaps a Local Sandbox process group",
    async ({ exitCode, signal }) => {
      const temporaryDirectory = await mkdtemp(join(tmpdir(), "aml-cli-signal-"))
      const pidFile = join(temporaryDirectory, "child.pid")
      const child = spawnCli(["run", resolve(fixtures, "signal-local-sandbox.tsx")], {
        cwd: repositoryRoot,
        env: { AML_SIGNAL_TEST_PID_FILE: pidFile },
      })
      let stderr = ""
      let stdout = ""
      child.stderr.setEncoding("utf8").on("data", chunk => (stderr += chunk))
      child.stdout.setEncoding("utf8").on("data", chunk => (stdout += chunk))

      try {
        const sandboxChildPid = Number((await waitForFile(pidFile)).trim())
        expect(sandboxChildPid).toBeGreaterThan(0)

        child.kill(signal)
        const completion = await waitForExit(child)

        expect(completion).toEqual({ code: exitCode, signal: null })
        expect(stdout).toBe("")
        expect(stderr).toContain("aml: starting run")
        expect(() => kill(sandboxChildPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        await rm(temporaryDirectory, { force: true, recursive: true })
      }
    }
  )

  it.skipIf(platform !== "linux")("reaps the active ACP Agent and Sandbox MCP relay before exiting", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "aml-cli-acp-signal-"))
    const acpPidFile = join(temporaryDirectory, "acp.pid")
    const promptFile = join(temporaryDirectory, "prompt.ready")
    const child = spawnCli(["run", resolve(fixtures, "signal-local-acp.tsx")], {
      cwd: repositoryRoot,
      env: {
        AML_SIGNAL_TEST_ACP_PID_FILE: acpPidFile,
        AML_SIGNAL_TEST_PROMPT_FILE: promptFile,
      },
    })

    try {
      await waitForFile(promptFile)
      const acpPid = Number((await readFile(acpPidFile, "utf8")).trim())
      const descendantPids = await readLinuxChildPids(child.pid)

      expect(descendantPids).toContain(acpPid)
      expect(descendantPids.length).toBeGreaterThanOrEqual(2)

      child.kill("SIGINT")
      await expect(waitForExit(child)).resolves.toEqual({ code: 130, signal: null })

      for (const pid of descendantPids) {
        expect(() => kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }))
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await rm(temporaryDirectory, { force: true, recursive: true })
    }
  })

  it.each([
    {
      args: ["unknown"],
      error: "unknown command: unknown",
      name: "unknown commands",
    },
    {
      args: ["run"],
      error: "missing required args for command `run <workflowFile>`",
      name: "missing positional arguments",
    },
    {
      args: ["run", resolve(fixtures, "exports.ts"), "--unknown"],
      error: "Unknown option `--unknown`",
      name: "unknown options",
    },
    {
      args: ["run", resolve(fixtures, "missing-export.ts")],
      error: 'must export either "default" or "main()"',
      name: "missing exports",
    },
    {
      args: ["run", resolve(fixtures, "invalid.ts")],
      error: "AML cannot render a value of type object",
      name: "invalid AML values",
    },
    {
      args: ["run", resolve(fixtures, "does-not-exist.ts")],
      error: "workflow file not found",
      name: "missing files",
    },
  ])("returns a failing exit status for $name", ({ args, error }) => {
    const result = runCli(args, { cwd: repositoryRoot })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(error)
  })
})

async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + 10_000

  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await delay(25)
    }
  }

  throw new Error(`timed out waiting for ${filePath}`)
}

async function readLinuxChildPids(parentPid: number | undefined): Promise<number[]> {
  if (parentPid === undefined) throw new Error("aml child process has no pid")
  // Linux exposes direct descendants atomically here, which lets this test
  // capture the ACP process and MCP relay before cancellation reaps them.
  const children = await readFile(`/proc/${parentPid}/task/${parentPid}/children`, "utf8")
  return children.trim().split(/\s+/u).filter(Boolean).map(Number)
}

async function waitForExit(
  child: ReturnType<typeof spawnCli>
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
  return await new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for aml to exit after signal")), 10_000)
    child.once("error", reject)
    child.once("close", (code, signal) => {
      clearTimeout(timeout)
      resolveExit({ code, signal })
    })
  })
}
