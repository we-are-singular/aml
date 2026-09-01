import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { Agent } from "../src/components/agent/agent.js"
import { File } from "../src/components/file/file.js"
import { Include } from "../src/components/include/include.js"
import { Sandbox } from "../src/components/sandbox/sandbox.js"
import { Workspace } from "../src/components/workspace/workspace.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { DeterministicAgentProvider } from "../src/testing/deterministic-agent-provider.js"
import { DeterministicSandboxProvider } from "../src/testing/deterministic-sandbox-provider.js"
import { DeterministicWorkspaceProvider } from "../src/testing/deterministic-workspace-provider.js"

describe("<Include>", () => {
  it("reads local UTF-8 sources live with derived, custom, or omitted headings", async () => {
    const directory = await temporaryDirectory("aml-include-src-")
    const source = path.join(directory, "brief.md")
    const runtime = new AmlRuntime({ cwd: directory })

    try {
      await writeFile(source, "first")
      await expect(runtime.evaluate(<Include src="./brief.md" />)).resolves.toBe("## Contents of `./brief.md`\n\nfirst")
      await expect(runtime.evaluate(<Include src="./brief.md" title="Brief" />)).resolves.toBe("## Brief\n\nfirst")
      await expect(runtime.evaluate(<Include src="./brief.md" title={false} />)).resolves.toBe("first")

      await writeFile(source, "second")
      await expect(runtime.evaluate(<Include src="./brief.md" title={false} />)).resolves.toBe("second")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("inlines multibyte UTF-8 content exactly at maxBytes", async () => {
    const directory = await temporaryDirectory("aml-include-boundary-")

    try {
      await writeFile(path.join(directory, "boundary.txt"), "é")

      await expect(
        new AmlRuntime({ cwd: directory }).evaluate(<Include maxBytes={2} src="./boundary.txt" title={false} />)
      ).resolves.toBe("é")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("stages an oversized local source at a readable Agent path", async () => {
    const directory = await temporaryDirectory("aml-include-stage-")
    let stagedPath = ""

    try {
      await writeFile(path.join(directory, "large.txt"), "0123456789")
      const provider = new DeterministicAgentProvider({
        async respond(request) {
          const match = /Read it at `([^`]+)`\./.exec(request.prompt)
          stagedPath = match?.[1] ?? ""
          expect(request.prompt).toBe(
            [
              `## Contents of \`${stagedPath}\``,
              "",
              `The file is 10 bytes, exceeding the 4-byte inline limit. Read it at \`${stagedPath}\`.`,
            ].join("\n")
          )
          expect(await readFile(stagedPath, "utf8")).toBe("0123456789")
          return { text: "done" }
        },
      })

      await expect(
        new AmlRuntime({ cwd: directory }).evaluate(
          <Agent provider={provider}>
            <Include maxBytes={4} src="./large.txt" />
          </Agent>
        )
      ).resolves.toBe("done")
      expect(stagedPath).toContain(`${path.sep}.aml${path.sep}includes${path.sep}`)
      await expect(access(stagedPath)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("reads active Workspace files after earlier authored writes", async () => {
    const directory = await temporaryDirectory("aml-include-workspace-")
    const workspace = new DeterministicWorkspaceProvider({ directory })
    const provider = new DeterministicAgentProvider({
      respond(request) {
        expect(request.prompt).toBe("## Contents of `brief.md`\n\ngenerated")
        return { text: "done" }
      },
    })

    try {
      await expect(
        new AmlRuntime().evaluate(
          <Workspace id="include-workspace" provider={workspace}>
            <File path="brief.md">generated</File>
            <Agent provider={provider}>
              <Include path="brief.md" />
            </Agent>
          </Workspace>
        )
      ).resolves.toBe("done")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("uses the live Sandbox filesystem in preference to an enclosing Workspace", async () => {
    const directory = await temporaryDirectory("aml-include-sandbox-")
    const workspace = new DeterministicWorkspaceProvider({ directory })
    const sandbox = new DeterministicSandboxProvider()
    const provider = new DeterministicAgentProvider({
      respond(request) {
        expect(request.prompt).toBe("guest")
        return { text: "done" }
      },
      supportsSandbox: () => true,
    })

    try {
      await expect(
        new AmlRuntime().evaluate(
          <Workspace id="include-sandbox" provider={workspace}>
            <File path="brief.md">workspace</File>
            <Sandbox access="read-write" provider={sandbox}>
              <File path="brief.md">guest</File>
              <Agent provider={provider}>
                <Include path="brief.md" title={false} />
              </Agent>
            </Sandbox>
          </Workspace>
        )
      ).resolves.toBe("done")
      expect(await readFile(path.join(directory, "brief.md"), "utf8")).toBe("workspace")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("references an oversized active file without copying it", async () => {
    const directory = await temporaryDirectory("aml-include-path-limit-")
    const workspace = new DeterministicWorkspaceProvider({ directory })

    try {
      await writeFile(path.join(directory, "large.txt"), "0123456789")
      await expect(
        new AmlRuntime().evaluate(
          <Workspace id="include-path-limit" provider={workspace}>
            <Include maxBytes={4} path="large.txt" />
          </Workspace>
        )
      ).resolves.toBe(
        [
          "## Contents of `large.txt`",
          "",
          "The file is 10 bytes, exceeding the 4-byte inline limit. Read it at `large.txt`.",
        ].join("\n")
      )
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("rejects missing scope, oversized source without an Agent, invalid UTF-8, and invalid props", async () => {
    const directory = await temporaryDirectory("aml-include-invalid-")
    const runtime = new AmlRuntime({ cwd: directory })
    const provider = new DeterministicAgentProvider()

    try {
      await writeFile(path.join(directory, "large.txt"), "0123456789")
      await writeFile(path.join(directory, "binary"), new Uint8Array([0xff, 0xff]))
      await mkdir(path.join(directory, "folder"))

      await expect(runtime.evaluate(<Include path="missing.txt" />)).rejects.toThrow(
        "requires an enclosing <Workspace> or <Sandbox>"
      )
      await expect(runtime.evaluate(<Include maxBytes={4} src="./large.txt" />)).rejects.toThrow(
        "requires a containing <Agent>"
      )
      await expect(runtime.evaluate(<Include src="./binary" />)).rejects.toThrow("must be valid UTF-8")
      await expect(
        runtime.evaluate(
          <Agent provider={provider}>
            <Include maxBytes={1} src="./binary" />
          </Agent>
        )
      ).rejects.toThrow("must be valid UTF-8")
      expect(provider.calls).toHaveLength(0)
      await expect(runtime.evaluate(<Include src="./folder" />)).rejects.toThrow("must identify a regular file")
      await expect(runtime.evaluate(<Include maxBytes={0} src="./large.txt" />)).rejects.toThrow(
        "maxBytes must be a positive safe integer"
      )
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})

async function temporaryDirectory(prefix: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix))
}
