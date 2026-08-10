import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { URL } from "node:url"

import { describe, expect, it } from "vitest"

import { runCli } from "./helpers/run-cli.js"

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
