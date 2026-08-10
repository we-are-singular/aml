import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

import {
  Agent,
  FollowUp,
  Sandbox,
  Script,
  System,
  evaluate,
  localSandbox,
  opencodeAgent,
  type AgentProvider,
  type AmlRenderable,
} from "@aml-jsx/sdk"
import { z } from "zod"

import { type ReleaseLane, updateChangelogDocument } from "./changelog-document.js"

/** The repository-grounded analysis produced before any public release copy is written. */
const AnalysisSchema = z.object({
  overview: z.string().trim().min(1),
  changes: z
    .array(
      z.object({
        explanation: z.string().trim().min(1),
        name: z.string().trim().min(1),
        relevantDocs: z.array(z.string().trim().min(1)),
      })
    )
    .min(1),
})

/** The editorial shape rendered into the changelog while preserving authored Markdown. */
const DraftSchema = z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  highlights: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        details: z.string().trim().min(1),
        links: z.array(
          z.object({
            label: z.string().trim().min(1),
            href: z.string().trim().startsWith("/docs/"),
          })
        ),
      })
    )
    .min(1),
})

/** All deterministic release evidence passed between the workflow's AML components. */
interface ReleaseContext {
  readonly commitList: string
  readonly currentTag: string
  readonly lane: ReleaseLane
  readonly previousTag: string
  readonly version: string
}

/** Release metadata available before the commit collector has run. */
type ReleaseFacts = Omit<ReleaseContext, "commitList">

const REPO_ROOT = path.resolve(import.meta.dirname, "..")
const CHANGELOG_MODEL = process.env.AML_CHANGELOG_MODEL ?? "opencode/mimo-v2.5-free"

/**
 * Wraps the repository-owned release notes script in AML's sandbox and script
 * primitives so commit collection remains deterministic and model-independent.
 */
export function ReleaseNotes({ lane, previousTag }: Pick<ReleaseFacts, "lane" | "previousTag">): AmlRenderable {
  // localSandbox executes a trusted host process and therefore requires read-write access; no model controls this Script.
  return (
    <Sandbox provider={localSandbox({ workspace: REPO_ROOT })} access="read-write">
      <Script command="node" args={["scripts/release-notes.ts", lane, previousTag, "HEAD"]} timeoutMs={30_000} />
    </Sandbox>
  )
}

/**
 * Gives a repository-aware Agent the authoritative commit list and permission
 * to inspect the corresponding diff, producing structured editorial evidence.
 */
export function AnalyzeRelease({
  provider,
  release,
}: {
  readonly provider: AgentProvider
  readonly release: ReleaseContext
}): AmlRenderable {
  return (
    <Agent provider={provider} permissions={{ filesystem: "read-only", network: false, shell: true }}>
      <System>
        Analyze release evidence. Be factual, user-oriented, and specific. Inspect the repository when commit subjects
        are insufficient.
      </System>
      Analyze the {release.lane.toUpperCase()} release {release.currentTag}. Previous tag: {release.previousTag}
      Git range: {release.previousTag}..HEAD Authoritative included commits:
      {release.commitList}
      Use read-only repository inspection to understand the actual diff and public impact. Separate user-visible
      behavior from internal maintenance. Suggest only existing public /docs/ routes in relevantDocs. Public routes do
      not include source extensions such as .mdx.
    </Agent>
  )
}

/**
 * Turns the grounded analysis into concise public release notes. This Agent
 * cannot inspect the shell, so it must write only from the supplied evidence.
 */
export function WriteChangelog({
  analysis,
  provider,
  release,
}: {
  readonly analysis: z.infer<typeof AnalysisSchema>
  readonly provider: AgentProvider
  readonly release: ReleaseContext
}): AmlRenderable {
  return (
    <Agent provider={provider} permissions={{ filesystem: "read-only", network: false, shell: false }}>
      <System>
        Write concise technical release notes from supplied evidence. Return only the requested structured result. Never
        invent documentation routes.
      </System>
      Prepare the changelog entry for {release.currentTag}. Editorial analysis:
      {JSON.stringify(analysis, null, 2)}
      Authoritative commit list:
      {release.commitList}
      Write a short title without the version, a summary, and a small set of explanatory highlights. Markdown and inline
      HTML such as &lt;code&gt; are allowed in the authored text. Put links only in the structured links arrays, and
      only when an existing AML docs page materially helps the reader.
      <FollowUp>
        Review the complete draft before returning it. Fix malformed Markdown or MDX, turn component-like angle-bracket
        text into code spans or safe &lt;code&gt; markup, and remove source extensions from public documentation links.
        Return the corrected structured changelog draft.
      </FollowUp>
    </Agent>
  )
}

/**
 * Composes the complete changelog workflow: collect commits, analyze the diff,
 * write the entry, then hand the structured result to the deterministic writer.
 */
export async function MaintainChangelog({ lane }: { readonly lane: ReleaseLane }): Promise<string> {
  // Resolve tags and versions before involving an Agent, then collect the exact commit range through AML.
  const facts = await readReleaseFacts(lane)
  const commitList = (await evaluate(<ReleaseNotes {...facts} />)).trim()

  if (commitList.length === 0) {
    throw new Error(`No ${lane.toUpperCase()} commits found after ${facts.previousTag}`)
  }

  const release = { ...facts, commitList }
  const provider = createChangelogAgent()

  // Separate investigation from writing so the final prose is based on structured, repository-grounded evidence.
  const analysis = await evaluate(<AnalyzeRelease provider={provider} release={release} />, AnalysisSchema)
  const draft = await evaluate(
    <WriteChangelog analysis={analysis} provider={provider} release={release} />,
    DraftSchema
  )
  const outputPath = await updateChangelogDocument({
    commitList,
    date: new Date().toISOString().slice(0, 10),
    draft,
    lane,
    repoRoot: REPO_ROOT,
    version: release.version,
  })

  return `Updated ${path.relative(REPO_ROOT, outputPath)} for ${release.currentTag}`
}

/** Creates the shared free-model provider used by both editorial Agents. */
function createChangelogAgent(): AgentProvider {
  const apiKey = process.env.OPENCODE_API_KEY
  if (!apiKey) {
    throw new Error("OPENCODE_API_KEY is required to maintain the changelog")
  }

  return opencodeAgent({
    directory: REPO_ROOT,
    env: { OPENCODE_API_KEY: apiKey },
    model: CHANGELOG_MODEL,
  })
}

/** Reads the package version and previous lane-specific tag without invoking a model. */
async function readReleaseFacts(lane: ReleaseLane): Promise<ReleaseFacts> {
  const packagePath = lane === "sdk" ? "sdk/package.json" : "apps/cli/package.json"
  const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, packagePath), "utf8")) as { version?: unknown }

  if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
    throw new TypeError(`${packagePath} must contain a stable semantic version`)
  }

  const match = lane === "sdk" ? "v[0-9]*" : "cli-v[0-9]*"
  const previousTag = execFileSync("git", ["describe", "--tags", "--match", match, "--abbrev=0"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim()
  const currentTag = lane === "sdk" ? `v${packageJson.version}` : `cli-v${packageJson.version}`

  if (previousTag === currentTag) {
    throw new Error(
      `${currentTag} already exists; bump the ${lane.toUpperCase()} package before updating its changelog`
    )
  }

  return { currentTag, lane, previousTag, version: packageJson.version }
}

/** AML CLI entrypoint for maintaining the SDK changelog during an SDK release. */
export const sdk = <MaintainChangelog lane="sdk" />

/** AML CLI entrypoint for maintaining the CLI changelog during a CLI release. */
export const cli = <MaintainChangelog lane="cli" />
