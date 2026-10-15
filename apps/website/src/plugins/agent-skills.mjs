import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath, URL } from "node:url"

import { create } from "tar"

const skillDirectory = new URL("../../../../skills/aml-jsx/", import.meta.url)
const archivedEntries = ["SKILL.md", "agents", "references"]

function readFrontmatterField(source, field) {
  const value = source.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))?.[1]?.trim()
  if (!value) throw new Error(`AML skill is missing its ${field} frontmatter field`)
  return value
}

/** Lists archive entries depth-first with names sorted, matching GNU tar's --sort=name order. */
async function sortedEntries(relativePath) {
  const entries = await readdir(new URL(relativePath, skillDirectory), { withFileTypes: true }).catch(error => {
    if (error.code === "ENOTDIR") return undefined
    throw error
  })
  if (entries === undefined) return [relativePath]

  const children = entries.map(entry => entry.name).sort()
  const nested = await Promise.all(children.map(name => sortedEntries(`${relativePath}/${name}`)))
  return [`${relativePath}/`, ...nested.flat()]
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

        // Build the archive in-process so its bytes do not depend on the host's
        // tar implementation: BSD tar lacks GNU's --sort and --mtime flags.
        const entries = (await Promise.all(archivedEntries.map(sortedEntries))).flat()
        await create(
          {
            cwd: fileURLToPath(skillDirectory),
            file: fileURLToPath(archive),
            gzip: true,
            mtime: new Date(0),
            noDirRecurse: true,
            portable: true,
          },
          entries
        )

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
