import { describe, expect, it } from "vitest"

import {
  DEFAULT_KITCHEN_SINK_SELECTION,
  KITCHEN_SINK_MCP_NAMES,
  KITCHEN_SINK_WORKSPACE_NAMES,
  parseKitchenSinkCommand,
  parseSmokeCommand,
  requiredCopilotGithubToken,
  resolveSmokeSandboxImage,
  selectSmokeCases,
  SMOKE_AGENT_NAMES,
  SMOKE_SANDBOX_NAMES,
} from "./smoke/smoke-config.js"

describe("smoke configuration", () => {
  it("derives the complete Cartesian product from both registries", () => {
    expect(SMOKE_AGENT_NAMES).toEqual(["codex", "copilot", "glm", "opencode", "pi"])
    expect(SMOKE_SANDBOX_NAMES).toEqual(["daytona", "docker", "local", "modal"])
    expect(selectSmokeCases()).toHaveLength(SMOKE_AGENT_NAMES.length * SMOKE_SANDBOX_NAMES.length)
    expect(selectSmokeCases()).toContainEqual({ agent: "codex", sandbox: "daytona" })
    expect(selectSmokeCases()).toContainEqual({ agent: "copilot", sandbox: "local" })
    expect(selectSmokeCases()).toContainEqual({ agent: "glm", sandbox: "local" })
    expect(selectSmokeCases()).toContainEqual({ agent: "pi", sandbox: "local" })
  })

  it("filters either axis without creating skipped cells", () => {
    expect(selectSmokeCases({ agent: "pi" })).toEqual(SMOKE_SANDBOX_NAMES.map(sandbox => ({ agent: "pi", sandbox })))
    expect(selectSmokeCases({ sandbox: "docker" })).toEqual(
      SMOKE_AGENT_NAMES.map(agent => ({ agent, sandbox: "docker" }))
    )
  })

  it("pins one requested image across image-backed smoke Sandboxes", () => {
    const image = "docker.io/wearesingular/aml-agent-sandbox@sha256:example"
    expect(resolveSmokeSandboxImage({ AML_SMOKE_SANDBOX_IMAGE: image })).toBe(image)
    expect(resolveSmokeSandboxImage({})).toBe("ghcr.io/we-are-singular/aml-agent-sandbox:dev")
  })

  it("parses CLI filters", () => {
    expect(parseSmokeCommand(["--agent", "codex", "--sandbox", "daytona"])).toEqual({
      kind: "run",
      selection: {
        agent: "codex",
        sandbox: "daytona",
      },
    })
    expect(parseSmokeCommand(["--list", "--agent", "pi"])).toEqual({
      kind: "list",
      selection: {
        agent: "pi",
      },
    })
  })

  it("rejects unknown and missing filters", () => {
    expect(() => parseSmokeCommand(["--agent", "missing"])).toThrow('Unknown smoke Agent "missing"')
    expect(() => parseSmokeCommand(["--sandbox"])).toThrow("--sandbox requires a value")
    expect(() => parseSmokeCommand(["--wat"])).toThrow('Unknown smoke argument "--wat"')
  })

  it("resolves Copilot credentials with an optional smoke override and native precedence", () => {
    expect(
      requiredCopilotGithubToken({
        AML_COPILOT_GITHUB_TOKEN: "smoke-override",
        COPILOT_GITHUB_TOKEN: "copilot-token",
        GH_TOKEN: "gh-token",
        GITHUB_TOKEN: "github-token",
      })
    ).toBe("smoke-override")
    expect(
      requiredCopilotGithubToken({
        COPILOT_GITHUB_TOKEN: "copilot-token",
        GH_TOKEN: "gh-token",
        GITHUB_TOKEN: "github-token",
      })
    ).toBe("copilot-token")
    expect(requiredCopilotGithubToken({ GH_TOKEN: "gh-token", GITHUB_TOKEN: "github-token" })).toBe("gh-token")
    expect(requiredCopilotGithubToken({ GITHUB_TOKEN: "github-token" })).toBe("github-token")
    expect(() => requiredCopilotGithubToken({})).toThrow("Copilot smoke requires COPILOT_GITHUB_TOKEN")
  })

  it("defaults the kitchen sink to R2, OpenCode, Modal, and Context7", () => {
    expect(parseKitchenSinkCommand([])).toEqual({
      kind: "run",
      selection: DEFAULT_KITCHEN_SINK_SELECTION,
    })
  })

  it("parses every kitchen-sink provider boundary", () => {
    expect(
      parseKitchenSinkCommand(["--agent", "codex", "--sandbox", "docker", "--workspace", "local", "--mcp", "none"])
    ).toEqual({
      kind: "run",
      selection: {
        agent: "codex",
        mcp: "none",
        sandbox: "docker",
        workspace: "local",
      },
    })
    expect(parseKitchenSinkCommand(["--help"])).toEqual({ kind: "help" })
  })

  it("rejects unknown and missing kitchen-sink selections", () => {
    expect(KITCHEN_SINK_WORKSPACE_NAMES).toEqual(["local", "r2"])
    expect(KITCHEN_SINK_MCP_NAMES).toEqual(["context7", "none"])
    expect(() => parseKitchenSinkCommand(["--workspace", "missing"])).toThrow(
      'Unknown kitchen-sink Workspace "missing"'
    )
    expect(() => parseKitchenSinkCommand(["--mcp"])).toThrow("--mcp requires a value")
    expect(() => parseKitchenSinkCommand(["--wat", "value"])).toThrow('Unknown kitchen-sink argument "--wat"')
  })
})
