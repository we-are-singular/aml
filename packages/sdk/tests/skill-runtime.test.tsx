import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  describe,
  expect,
  it,
} from "vitest"

import { Agent } from "../src/components/agent/agent.js"
import { Skill } from "../src/components/skill/skill.js"
import { System } from "../src/components/system/system.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { EvaluationError } from "../src/core/evaluation-error.js"
import { DeterministicAgentProvider } from "../src/testing/deterministic-agent-provider.js"

describe("Skill", () => {
  it("combines local, inline, metadata, and Agent-generated content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aml-skill-"))

    try {
      await writeFile(join(directory, "local.md"), "local")
      await writeFile(join(directory, "base.md"), "base")
      const provider = new DeterministicAgentProvider({
        respond(request) {
          if (request.prompt === "generate guidance") {
            return { text: "generated" }
          }

          expect(request.prompt).toBe(
            [
              "Start.",
              "local",
              "Skill: evidence\nDescription: Prefer concrete evidence.\n\ninline",
              "Skill: generated-review\n\nbase\ngenerated",
              "Finish.",
            ].join(""),
          )
          return { text: "done" }
        },
      })
      const runtime = new AmlRuntime({
        agentProvider: provider,
        cwd: directory,
      })

      await expect(
        runtime.evaluate(
          <Agent>
            {[
              "Start.",
              <Skill src="./local.md" />,
              <Skill
                name="evidence"
                description="Prefer concrete evidence."
              >
                inline
              </Skill>,
              <Skill src="./base.md" name="generated-review">
                <Agent>generate guidance</Agent>
              </Skill>,
              "Finish.",
            ]}
          </Agent>,
        ),
      ).resolves.toBe("done")
      expect(provider.calls).toHaveLength(2)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("preserves the exact one-newline separator between file and children", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aml-skill-separator-"))

    try {
      await writeFile(join(directory, "base.md"), "base\n")

      await expect(
        new AmlRuntime({ cwd: directory }).evaluate(
          <Skill src="./base.md">extra</Skill>,
        ),
      ).resolves.toBe("base\n\nextra")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("reads the file after inline AML children finish", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aml-skill-order-"))
    const path = join(directory, "mutable.md")

    try {
      await writeFile(path, "before")

      // This child effect proves Skill file access belongs to the post-order
      // completion frame rather than the initial node-dispatch branch.
      async function UpdateSkill() {
        await writeFile(path, "after")
        return "child"
      }

      await expect(
        new AmlRuntime({ cwd: directory }).evaluate(
          <Skill src="./mutable.md">
            <UpdateSkill />
          </Skill>,
        ),
      ).resolves.toBe("after\nchild")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("routes Skill text through a containing System channel", async () => {
    const provider = new DeterministicAgentProvider({
      respond(request) {
        expect(request.prompt).toBe("prompt")
        expect(request.system).toBe(
          "Skill: policy\n\nUse the repository policy.",
        )
        return { text: "done" }
      },
    })

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          <System>
            <Skill name="policy">
              Use the repository policy.
            </Skill>
          </System>
          prompt
        </Agent>,
      ),
    ).resolves.toBe("done")
  })

  it("reads local files on every evaluation instead of caching them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aml-skill-reload-"))
    const path = join(directory, "skill.md")

    try {
      const runtime = new AmlRuntime({ cwd: directory })
      await writeFile(path, "first")
      await expect(
        runtime.evaluate(<Skill src="./skill.md" />),
      ).resolves.toBe("first")

      await writeFile(path, "second")
      await expect(
        runtime.evaluate(<Skill src="./skill.md" />),
      ).resolves.toBe("second")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("rejects a missing file before the containing Agent executes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aml-skill-missing-"))
    const provider = new DeterministicAgentProvider()

    try {
      await expect(
        new AmlRuntime({
          agentProvider: provider,
          cwd: directory,
        }).evaluate(
          <Agent>
            <Skill src="./missing.md" />
            prompt
          </Agent>,
        ),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ code: "ENOENT" }),
        message: expect.stringContaining(
          "<Skill> could not read local file",
        ),
      })
      expect(provider.calls).toHaveLength(0)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("rejects missing, invalid, and empty Skill content", async () => {
    const runtime = new AmlRuntime()
    const UnsafeSkill = Skill as (
      props: Record<string, unknown>,
    ) => never

    await expect(runtime.evaluate(<Skill />)).rejects.toThrow(
      "<Skill> requires src, children, or both",
    )
    await expect(
      runtime.evaluate(<UnsafeSkill src="" />),
    ).rejects.toThrow("src must be a non-empty local path")
    await expect(
      runtime.evaluate(<UnsafeSkill src={42} />),
    ).rejects.toThrow("src must be a non-empty local path")
    await expect(
      runtime.evaluate(<Skill name=" trimmed ">content</Skill>),
    ).rejects.toThrow("name must be a non-empty normalized string")
    await expect(
      runtime.evaluate(<Skill description="">content</Skill>),
    ).rejects.toThrow(
      "description must be a non-empty normalized string",
    )
    await expect(runtime.evaluate(<Skill> </Skill>)).rejects.toThrow(
      "<Skill> must resolve to non-empty text",
    )
  })

  it("preserves caller cancellation identity during file access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aml-skill-abort-"))
    const cancellation = new Error("cancel Skill evaluation")
    const controller = new AbortController()

    try {
      await writeFile(join(directory, "skill.md"), "content")
      const pending = new AmlRuntime({ cwd: directory }).evaluate(
        <Skill src="./skill.md" />,
        { signal: controller.signal },
      )

      // evaluate() has entered the asynchronous read before returning its
      // promise, so this probes the Skill I/O boundary rather than preflight.
      controller.abort(cancellation)

      await expect(pending).rejects.toBe(cancellation)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("validates the runtime working directory", () => {
    expect(() => new AmlRuntime({ cwd: "" })).toThrow(
      "cwd must be a non-empty string",
    )
    expect(() => new AmlRuntime({ cwd: 42 as never })).toThrow(
      "cwd must be a non-empty string",
    )
  })

  it("attributes Skill file failures with EvaluationError", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aml-skill-error-"))

    try {
      const error = await new AmlRuntime({ cwd: directory })
        .evaluate(<Skill src="./missing.md" />)
        .catch((cause: unknown) => cause)

      expect(error).toBeInstanceOf(EvaluationError)
      expect(error).toMatchObject({
        cause: expect.objectContaining({ code: "ENOENT" }),
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
