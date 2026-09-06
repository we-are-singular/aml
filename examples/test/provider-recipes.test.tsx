import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AmlRuntime, localWorkspace, Workspace } from "@aml-jsx/sdk"
import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"
import { afterEach, describe, expect, test } from "vitest"

import { AnalyzeRepository } from "../src/integrations/glm-repository-analysis.js"
import { IssueTriage } from "../src/integrations/pi-issue-triage.js"

const issue = { number: 42, title: "Empty CSV export", body: "The exported file only contains the header." }
const triage = {
  category: "bug",
  priority: "normal",
  summary: "CSV export omits the displayed rows.",
  rationale: "The report describes a broken export without evidence of data loss.",
  missingDetails: ["Which browser and application version are you using?"],
}
const analysis = {
  purpose: "Export invoices as CSV.",
  findings: [
    {
      path: "README.md",
      evidence: "exports invoices as CSV",
      observation: "The README describes an invoice export service.",
      nextStep: "Check the export interface before integrating it.",
    },
  ],
  unknowns: ["The implementation was not inspected."],
}

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe("Pi issue-triage recipe", () => {
  test.each([true, false])(
    "derives labels and hands validated triage to the writer (missing details: %s)",
    async missing => {
      const classification = { ...triage, missingDetails: missing ? triage.missingDetails : [] }
      const provider = new DeterministicAgentProvider({
        respond: (_request, _context, index) =>
          index === 0 ? { text: "", structured: classification } : { text: "Could you share the application version?" },
      })

      const result = JSON.parse(await new AmlRuntime().evaluate(<IssueTriage issue={issue} provider={provider} />))

      expect(result).toEqual({
        issueNumber: 42,
        proposedLabels: missing ? ["bug", "priority:normal", "needs-information"] : ["bug", "priority:normal"],
        triage: classification,
        draftReply: "Could you share the application version?",
      })
      expect(provider.calls).toHaveLength(2)
      expect(provider.calls[0]?.request.prompt).toContain(JSON.stringify(issue))
      expect(provider.calls[1]?.request.prompt).toContain(JSON.stringify(classification))
      expect(provider.calls[1]?.request.prompt).not.toContain(issue.body)
      expect(provider.calls.every(call => call.request.permissions.shell === false)).toBe(true)
    }
  )

  test("rejects invalid issue input before calling the classifier", async () => {
    const provider = new DeterministicAgentProvider()
    await expect(
      new AmlRuntime().evaluate(<IssueTriage issue={{ ...issue, body: "" }} provider={provider} />)
    ).rejects.toThrow()
    expect(provider.calls).toHaveLength(0)
  })

  test("rejects an unapproved category before drafting a reply", async () => {
    const provider = new DeterministicAgentProvider({
      respond: () => ({ text: "", structured: { ...triage, category: "close-immediately" } }),
    })
    await expect(new AmlRuntime().evaluate(<IssueTriage issue={issue} provider={provider} />)).rejects.toThrow()
    expect(provider.calls).toHaveLength(1)
  })
})

describe("GLM repository-analysis recipe", () => {
  test("releases the workspace after a rejected quote so the same recipe can retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aml-repository-recipe-retry-"))
    directories.push(directory)
    await Promise.all([
      writeFile(join(directory, "README.md"), "A service that exports invoices as CSV."),
      writeFile(join(directory, "package.json"), '{"name":"invoice-exporter"}'),
    ])
    const invalid = new DeterministicAgentProvider({
      respond: () => ({
        text: "",
        structured: { ...analysis, findings: [{ ...analysis.findings[0], evidence: "All tests pass" }] },
      }),
    })
    await expect(
      new AmlRuntime().evaluate(
        <Workspace id="recipe-retry" provider={localWorkspace({ directory })} load={false} save={false}>
          <AnalyzeRepository provider={invalid} />
        </Workspace>
      )
    ).rejects.toThrow("Unverified evidence quote")

    const valid = new DeterministicAgentProvider({
      respond: (_request, _context, index) =>
        index === 0 ? { text: "", structured: analysis } : { text: "Retry completed." },
    })
    await expect(
      new AmlRuntime().evaluate(
        <Workspace id="recipe-retry" provider={localWorkspace({ directory })} load={false} save={false}>
          <AnalyzeRepository provider={valid} />
        </Workspace>
      )
    ).resolves.toBe("Retry completed.")
    expect(valid.calls).toHaveLength(2)
  })

  test.each([
    "valid",
    "valid multiline quote",
    "reformatted quote",
    "fabricated quote",
    "unknown path",
    "oversized input",
  ])("checks evidence before synthesis: %s", async scenario => {
    const directory = await mkdtemp(join(tmpdir(), "aml-repository-recipe-test-"))
    directories.push(directory)
    const readme = scenario === "oversized input" ? "x".repeat(24_001) : "A service that exports invoices as CSV."
    const manifest = '{\n  "name": "invoice-exporter"\n}'
    await Promise.all([
      writeFile(join(directory, "README.md"), readme),
      writeFile(join(directory, "package.json"), manifest),
    ])
    const finding = analysis.findings[0]
    const candidate = {
      ...analysis,
      findings: [
        {
          ...finding,
          ...(scenario === "fabricated quote" ? { evidence: "All tests pass" } : {}),
          ...(scenario === "unknown path" ? { path: "src/secrets.ts" } : {}),
          ...(scenario === "valid multiline quote" ? { path: "package.json", evidence: manifest } : {}),
          ...(scenario === "reformatted quote"
            ? { path: "package.json", evidence: '{"name":"invoice-exporter"}' }
            : {}),
        },
      ],
    }
    const provider = new DeterministicAgentProvider({
      respond: (_request, _context, index) =>
        index === 0
          ? { text: "", structured: candidate }
          : { text: "Inspect the CSV interface; implementation remains unverified." },
    })
    const run = new AmlRuntime().evaluate(
      <Workspace id="recipe-test" provider={localWorkspace({ directory })} load={false} save={false}>
        <AnalyzeRepository provider={provider} />
      </Workspace>
    )

    if (scenario === "valid" || scenario === "valid multiline quote") {
      await expect(run).resolves.toBe("Inspect the CSV interface; implementation remains unverified.")
      expect(provider.calls).toHaveLength(2)
      expect(provider.calls[0]?.request.prompt).toContain(readme)
      expect(provider.calls[0]?.request.prompt).toContain(manifest)
      expect(provider.calls[1]?.request.prompt).toContain(JSON.stringify(candidate))
    } else {
      await expect(run).rejects.toThrow()
      expect(provider.calls).toHaveLength(scenario === "oversized input" ? 0 : 1)
    }
  })
})
