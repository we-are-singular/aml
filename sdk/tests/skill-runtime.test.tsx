import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { Agent } from "../src/components/agent/agent.js"
import type { AgentProvider } from "../src/components/agent/agent-provider.js"
import { FollowUp } from "../src/components/follow-up/follow-up.js"
import { Skill } from "../src/components/skill/skill.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import type { AmlTraceEvent } from "../src/observability/trace-event.js"
import { DeterministicAgentProvider } from "../src/testing/deterministic-agent-provider.js"

describe("<Skill>", () => {
  it("stages a complete package and supplies metadata-only fallback", async () => {
    const directory = await temporaryDirectory()

    try {
      await writeSkill(directory, "review", "Review code with evidence.", {
        "references/checklist.md": "Check behavior before style.\n",
        "scripts/probe.bin": new Uint8Array([0, 1, 2, 255]),
      })

      let stagedDirectory = ""
      let stagedSkillFile = ""
      const provider = new DeterministicAgentProvider({
        async respond(request) {
          const [skill] = request.skills

          expect(skill).toBeDefined()
          expect(skill).toMatchObject({
            description: "Review code with evidence.",
            name: "review",
          })
          expect(skill?.directory).toBe(path.join(skill?.skillHome ?? "", "skills", "review"))
          expect(request.prompt).toBe("Inspect the change.")
          expect(request.system).toBe(
            [
              "## Available skill: `review`",
              "Use when: Review code with evidence.",
              `Read \`${skill?.skillFile}\` when this skill applies.`,
            ].join("\n")
          )
          expect(await readFile(skill?.skillFile ?? "", "utf8")).toContain("name: review")
          expect(await readFile(path.join(skill?.directory ?? "", "references/checklist.md"), "utf8")).toBe(
            "Check behavior before style.\n"
          )
          expect(await readFile(path.join(skill?.directory ?? "", "scripts/probe.bin"))).toEqual(
            Buffer.from([0, 1, 2, 255])
          )
          expect(Object.isFrozen(request.skills)).toBe(true)
          expect(Object.isFrozen(skill)).toBe(true)
          stagedDirectory = skill?.directory ?? ""
          stagedSkillFile = skill?.skillFile ?? ""
          return { text: "done" }
        },
      })

      await expect(
        new AmlRuntime({ cwd: directory }).evaluate(
          <Agent provider={provider}>
            <Skill src="./review" />
            Inspect the change.
          </Agent>
        )
      ).resolves.toBe("done")

      expect(stagedDirectory).toContain(`${path.sep}.agents${path.sep}skills${path.sep}review`)
      expect(stagedSkillFile).toBe(path.join(stagedDirectory, "SKILL.md"))
      await expect(access(stagedDirectory)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("omits fallback when the provider declares native discovery", async () => {
    const directory = await temporaryDirectory()

    try {
      await writeSkill(directory, "review", "Review code.")
      const provider: AgentProvider = {
        name: "native-skills",
        async run(request) {
          expect(request.skills).toHaveLength(1)
          expect(request.system).toBe("authored system")
          return { text: "native" }
        },
        skillDiscovery: "native",
      }

      await expect(
        new AmlRuntime({ cwd: directory }).evaluate(
          <Agent provider={provider} system="authored system">
            <Skill src="./review" />
          </Agent>
        )
      ).resolves.toBe("native")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("reads package metadata live for every evaluation", async () => {
    const directory = await temporaryDirectory()
    const descriptions: string[] = []
    const provider = new DeterministicAgentProvider({
      respond(request) {
        descriptions.push(request.skills[0]?.description ?? "missing")
        return { text: "done" }
      },
    })
    const runtime = new AmlRuntime({ cwd: directory })

    try {
      await writeSkill(directory, "review", "First description.")
      await runtime.evaluate(
        <Agent provider={provider}>
          <Skill src="./review" />
        </Agent>
      )
      await writeSkill(directory, "review", "Second description.")
      await runtime.evaluate(
        <Agent provider={provider}>
          <Skill src="./review" />
        </Agent>
      )

      expect(descriptions).toEqual(["First description.", "Second description."])
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("cleans staging when provider execution fails", async () => {
    const directory = await temporaryDirectory()
    let stagedDirectory = ""

    try {
      await writeSkill(directory, "review", "Review code.")
      const provider = new DeterministicAgentProvider({
        respond(request) {
          stagedDirectory = request.skills[0]?.directory ?? ""
          throw new Error("provider failed")
        },
      })

      await expect(
        new AmlRuntime({ cwd: directory }).evaluate(
          <Agent provider={provider}>
            <Skill src="./review" />
          </Agent>
        )
      ).rejects.toThrow('Agent "deterministic"')
      await expect(access(stagedDirectory)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("traces package staging and its Agent capability grant without content", async () => {
    const directory = await temporaryDirectory()
    const events: AmlTraceEvent[] = []

    try {
      await writeSkill(directory, "review", "PRIVATE_DESCRIPTION", {
        "references/private.md": "PRIVATE_BODY",
      })

      await new AmlRuntime({
        cwd: directory,
        trace(event) {
          events.push(event)
        },
      }).evaluate(
        <Agent provider={new DeterministicAgentProvider()}>
          <Skill src="./review" />
        </Agent>
      )

      expect(events.find(event => event.type === "span.end" && event.kind === "skill")).toMatchObject({
        attributes: { files: 2, name: "review" },
        status: "ok",
      })
      expect(events.find(event => event.type === "event" && event.name === "capability.skill")).toMatchObject({
        attributes: { name: "review", native: false },
      })
      expect(JSON.stringify(events)).not.toContain("PRIVATE_DESCRIPTION")
      expect(JSON.stringify(events)).not.toContain("PRIVATE_BODY")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("rejects duplicate names and placement outside an Agent", async () => {
    const directory = await temporaryDirectory()

    try {
      await writeSkill(directory, "review", "Review code.")
      const runtime = new AmlRuntime({ cwd: directory })

      await expect(runtime.evaluate(<Skill src="./review" />)).rejects.toThrow("<Skill> is only valid inside <Agent>")
      await expect(
        runtime.evaluate(
          <Agent provider={new DeterministicAgentProvider()}>
            <FollowUp>
              <Skill src="./review" />
            </FollowUp>
          </Agent>
        )
      ).rejects.toThrow("<Skill> is invalid inside <FollowUp>")
      await expect(
        runtime.evaluate(
          <Agent provider={new DeterministicAgentProvider()}>
            <Skill src="./review" />
            <Skill src="./review" />
          </Agent>
        )
      ).rejects.toThrow('Agent declares duplicate Skill "review"')
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("rejects invalid packages, remote sources, and symbolic links", async () => {
    const directory = await temporaryDirectory()
    const provider = new DeterministicAgentProvider()

    try {
      await mkdir(path.join(directory, "missing"))
      await mkdir(path.join(directory, "mismatch"))
      await writeFile(
        path.join(directory, "mismatch", "SKILL.md"),
        "---\nname: another\ndescription: Mismatch.\n---\nBody.\n"
      )
      await writeSkill(directory, "linked", "Linked package.")
      await symlink("../linked/SKILL.md", path.join(directory, "linked", "alias.md"))

      const evaluateSkill = async (src: string) =>
        await new AmlRuntime({ cwd: directory }).evaluate(
          <Agent provider={provider}>
            <Skill src={src} />
          </Agent>
        )

      await expect(evaluateSkill("./missing")).rejects.toThrow('must contain a root "SKILL.md"')
      await expect(evaluateSkill("./mismatch")).rejects.toThrow("must match package directory")
      await expect(evaluateSkill("./linked")).rejects.toThrow("must not contain symbolic link")
      await expect(evaluateSkill("https://skills.example/review")).rejects.toThrow("remote URLs are not supported")

      const UnsafeSkill = Skill as unknown as (props: Record<string, unknown>) => never
      await expect(
        new AmlRuntime({ cwd: directory }).evaluate(
          <Agent provider={provider}>
            <UnsafeSkill src="" />
          </Agent>
        )
      ).rejects.toThrow("src must be a non-empty normalized local path")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})

async function temporaryDirectory(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "aml-skill-test-"))
}

async function writeSkill(
  root: string,
  name: string,
  description: string,
  files: Readonly<Record<string, string | Uint8Array>> = {}
): Promise<void> {
  const directory = path.join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nPackage instructions.\n`
  )

  for (const [relativePath, content] of Object.entries(files)) {
    const destination = path.join(directory, ...relativePath.split("/"))
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, content)
  }
}
