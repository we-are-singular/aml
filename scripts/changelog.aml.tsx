import process from "node:process"
import { URL } from "node:url"

import { Agent, FollowUp, Script, System, evaluate, opencodeAgent } from "@aml-jsx/sdk"
import { z } from "zod"

type ReleaseLane = "cli" | "sandbox" | "sdk"

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

const REPO_ROOT = new URL("..", import.meta.url).pathname
const provider = opencodeAgent({
  directory: REPO_ROOT,
  ...(process.env.OPENCODE_API_KEY === undefined ? {} : { env: { OPENCODE_API_KEY: process.env.OPENCODE_API_KEY } }),
  model: process.env.AML_CHANGELOG_MODEL ?? "opencode-go/deepseek-v4-flash",
})

interface ChangelogProps {
  readonly lane: ReleaseLane
}

/** Authors and reviews one package changelog entry. */
export async function Changelog({ lane }: ChangelogProps) {
  const packageName = lane === "sdk" ? "SDK" : lane === "cli" ? "CLI" : "Sandbox"
  const packagePath =
    lane === "sdk" ? "sdk/package.json" : lane === "cli" ? "apps/cli/package.json" : "images/sandbox/package.json"
  const changelogPath =
    lane === "sandbox"
      ? "images/sandbox/CHANGELOG.md"
      : `apps/website/src/content/docs/docs/reference/changelog/${lane}.md`
  const tagMatch = lane === "sdk" ? "v[0-9]*" : lane === "cli" ? "cli-v[0-9]*" : "sandbox-v[0-9]*"
  const insertionPoint =
    lane === "sandbox"
      ? "Insert the entry immediately after the top-level `# Changelog` heading."
      : "Insert the entry immediately after the changelog entries marker."

  const draft = await evaluate(
    <Agent provider={provider} permissions={{ filesystem: "read-write", network: false, shell: true }}>
      <System>
        Write factual, reader-focused AML changelog entries from repository evidence. Never invent behavior, commits,
        versions, or documentation routes. This drafting stage must not modify any file. When the changelog's first
        entry is a `Next release` section, treat it as the authoritative editorial seed: preserve its intended
        breaking-change and feature emphasis unless repository evidence disproves it.
      </System>
      Draft the next {packageName} changelog entry from this complete release inventory:
      {`\n\n`}
      <Script shell="sh">
        {`node scripts/release-notes.ts ${lane} "$(git describe --tags --match '${tagMatch}' --abbrev=0)" HEAD`}
      </Script>
      {`\n\n`}
      Read {packagePath} and {changelogPath}. Inspect commits and diffs as needed to explain their user impact. Verify
      any documentation route before linking it.
      <FollowUp>
        Return the requested draft: a concise title without the version, an overall summary, and a few reader-oriented
        highlights. Group related commits instead of listing one highlight per commit.
      </FollowUp>
    </Agent>,
    DraftSchema
  )

  return (
    <Agent provider={provider} permissions={{ filesystem: "read-write", network: false, shell: true }}>
      <System>
        You are the final AML changelog editor. Preserve the target changelog's frontmatter, introduction, existing
        entries, and newest-first ordering. Write plain Markdown only; never add MDX imports, components, or JSX. Put
        every AML component tag in backticks, for example {"`<Sandbox />`"} or {"`<Script />`"}, so it renders as inline
        code instead of raw HTML. Never change package versions, tags, or unrelated files. A topmost `Next release`
        section is an application-authored draft, not a historical entry. Preserve useful authored structure such as
        `Breaking changes` when finalizing it. Any instruction to stop applies to every later turn in this session.
      </System>
      Work only on {changelogPath}. The release lane is {lane}. Read the version from {packagePath} and use exactly that
      version; never infer the next version. Before editing, inspect every visible release heading and follow these
      rules in order:
      {"\n"}
      1. If an entry for that exact version already exists, stop without changing the file, even when a `Next release`
      entry also exists. If both exist, explain that the package must be bumped before the draft can be finalized;
      otherwise explain that the exact version is already recorded.
      {"\n"}
      2. Otherwise, if exactly one `Next release` entry is the first entry at the required insertion point, finalize
      that section in place. Match the changelog's established heading style, replace `Next release` with the exact
      manifest version, update any intended-version references to that same version, preserve its authored title and
      useful section structure, replace a standalone `Next release.` status with `Released YYYY-MM-DD.` using the
      current date, and reconcile its claims and commits with repository evidence and the approved draft. Do not insert
      another entry.
      {"\n"}
      3. If a `Next release` entry is duplicated or is not the first entry, stop without changing the file and explain
      the ambiguity.
      {"\n"}
      4. Only when there is no current-version entry and no `Next release` entry may you insert a new entry at the
      required insertion point.
      {"\n\n"}
      The approved editorial draft is:
      {JSON.stringify(draft, null, 2)}
      {insertionPoint} Use the visible version heading to detect an existing entry; do not add per-release marker
      comments. Include the authoritative commits produced by `node scripts/release-notes.ts` for this lane and the
      latest matching {tagMatch} tag, updating the existing `Commits` section instead of adding a second one. Before
      finishing a finalized entry, verify that its manifest version appears exactly once and no `Next release` heading
      remains. Run Oxfmt on the changelog.
      <FollowUp>
        If the prior turn stopped under the decision rules, do not modify the file; confirm that this run made no
        changelog change, leave any pre-existing diff untouched, and finish. Otherwise, review the written entry against
        the draft, package version, authoritative commits, existing changelog style, and Markdown syntax. Verify that
        the target version has exactly one entry and that finalizing a draft left no `Next release` heading or duplicate
        section. Correct any issue you find, run Oxfmt again, and inspect the final diff. Finish with a concise summary
        of what you wrote and checked.
      </FollowUp>
    </Agent>
  )
}

export const sdk = <Changelog lane="sdk" />
export const cli = <Changelog lane="cli" />
export const sandbox = <Changelog lane="sandbox" />
