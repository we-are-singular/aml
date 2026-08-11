import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath, URL } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const skillDirectory = new URL("../../../../skills/aml-jsx/", import.meta.url)

function readFrontmatterField(source, field) {
  const value = source.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))?.[1]?.trim()
  if (!value) throw new Error(`AML skill is missing its ${field} frontmatter field`)
  return value
}

/** Publishes the repository's AML skill through the agent-skills discovery well-known URI. */
export function agentSkillsPlugin() {
  return {
    name: "aml-agent-skills",
    hooks: {
      async "astro:build:done"({ dir }) {
        const outputDirectory = new URL(".well-known/agent-skills/", dir)
        const archive = new URL("aml-jsx.tar.gz", outputDirectory)
        await mkdir(outputDirectory, { recursive: true })

        await execute("tar", [
          "--create",
          "--gzip",
          "--file",
          fileURLToPath(archive),
          "--directory",
          fileURLToPath(skillDirectory),
          "--sort=name",
          "--mtime=@0",
          "--owner=0",
          "--group=0",
          "--numeric-owner",
          "SKILL.md",
          "agents",
          "references",
        ])

        const [archiveBytes, skillSource] = await Promise.all([
          readFile(archive),
          readFile(new URL("SKILL.md", skillDirectory), "utf8"),
        ])
        const index = {
          $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
          skills: [
            {
              name: readFrontmatterField(skillSource, "name"),
              type: "archive",
              description: readFrontmatterField(skillSource, "description"),
              url: "/.well-known/agent-skills/aml-jsx.tar.gz",
              digest: `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`,
            },
          ],
        }

        await writeFile(new URL("index.json", outputDirectory), `${JSON.stringify(index, null, 2)}\n`)
      },
    },
  }
}
