import process from "node:process"
import { URL } from "node:url"

import { Agent, FollowUp, Script, System, evaluate, opencodeAgent } from "@aml-jsx/sdk"
import { z } from "zod"

type ReleaseLane = "cli" | "sdk"

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
  model: process.env.AML_CHANGELOG_MODEL ?? "opencode/deepseek-v4-flash-free",
})

interface ChangelogProps {
  readonly lane: ReleaseLane
}

/** Authors and reviews one package changelog entry. */
export async function Changelog({ lane }: ChangelogProps) {
  const packageName = lane === "sdk" ? "SDK" : "CLI"
  const packagePath = lane === "sdk" ? "sdk/package.json" : "apps/cli/package.json"
  const changelogPath = `apps/website/src/content/docs/docs/reference/changelog/${lane}.md`
  const tagMatch = lane === "sdk" ? "v[0-9]*" : "cli-v[0-9]*"

  const draft = await evaluate(
    <Agent provider={provider} permissions={{ filesystem: "read-write", network: false, shell: true }}>
      <System>
        Write factual, reader-focused AML changelog entries from repository evidence. Never invent behavior, commits,
        versions, or documentation routes.
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
        code instead of raw HTML. Never change package versions, tags, or unrelated files.
      </System>
      Work only on {changelogPath}. The release lane is {lane}. Read the version from {packagePath} and use exactly that
      version; never infer the next version. If that version already has a changelog entry, stop without changing the
      file and explain that the package must be bumped first. The approved editorial draft is:
      {JSON.stringify(draft, null, 2)}
      Insert the entry for the current package version immediately after the changelog entries marker. Use the visible
      version heading to detect an existing entry; do not add per-release marker comments. Include the authoritative
      commits produced by `node scripts/release-notes.ts` for this lane and the latest matching {tagMatch} tag. Run
      Oxfmt on the changelog.
      <FollowUp>
        Review the written entry against the draft, package version, authoritative commits, existing changelog style,
        and Markdown syntax. Correct any issue you find, run Oxfmt again, and inspect the final diff. Finish with a
        concise summary of what you wrote and checked.
      </FollowUp>
    </Agent>
  )
}

export const sdk = <Changelog lane="sdk" />
export const cli = <Changelog lane="cli" />
