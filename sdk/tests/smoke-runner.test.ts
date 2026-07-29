import { describe, expect, it } from "vitest"

import { parseSmokeCommand, selectSmokeCases, smokeAgentNames, smokeSandboxNames } from "./smoke/smoke-matrix.js"

describe("smoke matrix runner", () => {
  it("derives the complete Cartesian product from both registries", () => {
    expect(smokeAgentNames()).toContain("codex")
    expect(smokeAgentNames()).toContain("opencode")
    expect(smokeAgentNames()).toContain("pi")
    expect(smokeSandboxNames()).toContain("daytona")
    expect(smokeSandboxNames()).toContain("docker")
    expect(smokeSandboxNames()).toContain("local")
    expect(selectSmokeCases()).toHaveLength(smokeAgentNames().length * smokeSandboxNames().length)
    expect(selectSmokeCases()).toContainEqual({ agent: "codex", sandbox: "daytona" })
    expect(selectSmokeCases()).toContainEqual({ agent: "pi", sandbox: "local" })
  })

  it("filters either axis without creating skipped cells", () => {
    expect(selectSmokeCases({ agent: "pi" })).toEqual(smokeSandboxNames().map(sandbox => ({ agent: "pi", sandbox })))
    expect(selectSmokeCases({ sandbox: "docker" })).toEqual(
      smokeAgentNames().map(agent => ({ agent, sandbox: "docker" }))
    )
  })

  it("parses separate and equals-form CLI filters", () => {
    expect(parseSmokeCommand(["--agent", "codex", "--sandbox=daytona"])).toEqual({
      kind: "run",
      selection: {
        agent: "codex",
        sandbox: "daytona",
      },
    })
    expect(parseSmokeCommand(["--list", "--agent=pi"])).toEqual({
      kind: "list",
      selection: {
        agent: "pi",
      },
    })
  })

  it("rejects unknown, missing, and duplicate filters", () => {
    expect(() => parseSmokeCommand(["--agent", "missing"])).toThrow('Unknown smoke Agent "missing"')
    expect(() => parseSmokeCommand(["--sandbox"])).toThrow("--sandbox requires a value")
    expect(() => parseSmokeCommand(["--agent=pi", "--agent=codex"])).toThrow("--agent may be provided only once")
    expect(() => parseSmokeCommand(["--wat"])).toThrow('Unknown smoke argument "--wat"')
  })
})
