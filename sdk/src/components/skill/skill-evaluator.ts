import { lstat, readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { parseDocument } from "yaml"

import { EvaluationError } from "../../core/evaluation-error.js"
import type { AgentFileStaging, AgentStagedFile } from "../agent/agent-file-staging.js"
import type { AgentSkill } from "./agent-skill.js"
import type { SkillProps } from "./skill.js"

/** Safe trace metadata produced while staging one complete Skill package. */
export interface SkillEvaluationResult {
  readonly files: number
  readonly skill: Readonly<AgentSkill>
}

/** Owns local Agent Skill package validation, copying, and metadata capture. */
export class SkillEvaluator {
  readonly #cwd: string

  /** Captures the application directory used by local Skill sources. */
  constructor(cwd: unknown) {
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new TypeError("cwd must be a non-empty string")
    }

    this.#cwd = path.resolve(cwd)
  }

  /** Validates and stages one complete package before its Agent starts. */
  async evaluate(
    props: Readonly<SkillProps>,
    staging: AgentFileStaging,
    signal: AbortSignal
  ): Promise<Readonly<SkillEvaluationResult>> {
    const source = captureSource(props)
    const sourceDirectory = path.resolve(this.#cwd, source)

    try {
      signal.throwIfAborted()
      const metadata = await lstat(sourceDirectory)

      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new EvaluationError("<Skill> src must identify a local package directory")
      }

      const files = await readPackageFiles(sourceDirectory, signal)
      const skillFile = files.find(file => file.relativePath === "SKILL.md")

      if (skillFile === undefined) {
        throw new EvaluationError('<Skill> package must contain a root "SKILL.md"')
      }

      const frontmatter = parseSkillFrontmatter(skillFile.content)
      const sourceName = path.basename(sourceDirectory)

      if (sourceName !== frontmatter.name) {
        throw new EvaluationError(
          `<Skill> frontmatter name "${frontmatter.name}" must match package directory "${sourceName}"`
        )
      }

      let stagedSkillFile: Readonly<AgentStagedFile> | undefined

      for (const file of files) {
        const stagedFile = await staging.writeFile(
          `.agents/skills/${frontmatter.name}/${file.relativePath}`,
          file.content
        )

        if (file.relativePath === "SKILL.md") {
          stagedSkillFile = stagedFile
        }
      }

      if (stagedSkillFile === undefined) {
        throw new Error("Skill package staging omitted SKILL.md")
      }

      const skillHome = await staging.resolvePath(".agents")
      const skill: AgentSkill = Object.freeze({
        description: frontmatter.description,
        directory: stagedSkillFile.directory,
        name: frontmatter.name,
        skillHome,
        skillFile: stagedSkillFile.path,
      })

      return Object.freeze({ files: files.length, skill })
    } catch (cause) {
      signal.throwIfAborted()

      if (cause instanceof EvaluationError) {
        throw cause
      }

      throw new EvaluationError(`<Skill> could not prepare local package "${sourceDirectory}"`, { cause })
    }
  }
}

interface PackageFile {
  readonly content: Uint8Array
  readonly relativePath: string
}

interface SkillFrontmatter {
  readonly description: string
  readonly name: string
}

function captureSource(props: Readonly<SkillProps>): string {
  const children = Reflect.get(props, "children")
  const source = Reflect.get(props, "src")

  if (children !== undefined) {
    throw new EvaluationError("<Skill> does not accept children")
  }

  if (typeof source !== "string" || source.length === 0 || source !== source.trim()) {
    throw new EvaluationError("<Skill> src must be a non-empty normalized local path")
  }

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(source)) {
    throw new EvaluationError("<Skill> src must be local; remote URLs are not supported")
  }

  return source
}

async function readPackageFiles(root: string, signal: AbortSignal): Promise<readonly PackageFile[]> {
  const files: PackageFile[] = []

  // Directory entries are sorted at every level so provider requests and tests
  // do not depend on filesystem enumeration order.
  const visit = async (physicalDirectory: string, relativeDirectory: string): Promise<void> => {
    signal.throwIfAborted()
    const entries = await readdir(physicalDirectory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      const physicalPath = path.join(physicalDirectory, entry.name)
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`

      if (entry.isSymbolicLink()) {
        throw new EvaluationError(`<Skill> package must not contain symbolic link "${relativePath}"`)
      }

      if (entry.isDirectory()) {
        await visit(physicalPath, relativePath)
        continue
      }

      if (!entry.isFile()) {
        throw new EvaluationError(`<Skill> package contains unsupported entry "${relativePath}"`)
      }

      const content = await readFile(physicalPath, { signal })
      files.push(Object.freeze({ content: Uint8Array.from(content), relativePath }))
    }
  }

  await visit(root, "")
  return Object.freeze(files)
}

function parseSkillFrontmatter(content: Uint8Array): Readonly<SkillFrontmatter> {
  let source: string

  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(content)
  } catch (cause) {
    throw new EvaluationError('<Skill> package "SKILL.md" must be valid UTF-8', { cause })
  }

  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)

  if (match === null) {
    throw new EvaluationError('<Skill> package "SKILL.md" must begin with YAML frontmatter')
  }

  const document = parseDocument(match[1] ?? "", {
    logLevel: "silent",
    schema: "core",
  })

  if (document.errors.length > 0) {
    throw new EvaluationError('<Skill> package "SKILL.md" has invalid YAML frontmatter', {
      cause: document.errors[0],
    })
  }

  let value: unknown

  try {
    value = document.toJS({ mapAsMap: false, maxAliasCount: 0 })
  } catch (cause) {
    throw new EvaluationError('<Skill> package "SKILL.md" has unsafe YAML frontmatter', { cause })
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EvaluationError('<Skill> package "SKILL.md" frontmatter must be a mapping')
  }

  const name = Reflect.get(value, "name")
  const description = Reflect.get(value, "description")

  if (typeof name !== "string" || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new EvaluationError("<Skill> frontmatter name must be a safe lowercase hyphenated segment")
  }

  if (
    typeof description !== "string" ||
    description.length === 0 ||
    description.length > 1024 ||
    description !== description.trim()
  ) {
    throw new EvaluationError("<Skill> frontmatter description must be a normalized string of at most 1024 characters")
  }

  return Object.freeze({ description, name })
}
