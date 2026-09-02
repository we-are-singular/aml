import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { Agent } from "../src/components/agent/agent.js"
import { File } from "../src/components/file/file.js"
import { Include } from "../src/components/include/include.js"
import { Sandbox } from "../src/components/sandbox/sandbox.js"
import type { SandboxProvider } from "../src/components/sandbox/sandbox-provider.js"
import type { SandboxExecOptions } from "../src/components/sandbox/sandbox-runtime.js"
import { Workspace } from "../src/components/workspace/workspace.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { evaluate } from "../src/core/evaluate.js"
import { DeterministicAgentProvider } from "../src/testing/deterministic-agent-provider.js"
import { DeterministicSandboxProvider } from "../src/testing/deterministic-sandbox-provider.js"
import { DeterministicWorkspaceProvider } from "../src/testing/deterministic-workspace-provider.js"

describe("<Include>", () => {
  it("reuses cached content for an unchanged file while preserving Include traces", async () => {
    const reads = instrumentedSandbox({ files: { "brief.md": "shared" } })
    const runtime = new AmlRuntime()
    const includeStarts: string[] = []
    runtime.on("trace", event => {
      if (event.type === "span.start" && event.kind === "include") {
        includeStarts.push(event.spanId)
      }
    })

    async function SequentialIncludes() {
      const first = await evaluate(<Include path="brief.md" title={false} />)
      const second = await evaluate(<Include maxBytes={10} path="brief.md" title={false} />)
      return `${first}${second}`
    }

    await expect(
      runtime.evaluate(
        <Sandbox access="read-only" provider={reads.provider}>
          <SequentialIncludes />
        </Sandbox>
      )
    ).resolves.toBe("sharedshared")
    expect(reads.statCalls).toEqual(["brief.md", "brief.md"])
    expect(reads.readCalls).toEqual(["brief.md"])
    expect(includeStarts).toHaveLength(2)
  })

  it("does not cache rejected reads and invalidates changed revisions", async () => {
    const reads = instrumentedSandbox({ failFirstRead: true, files: { "brief.md": "first" } })
    let rejected = false

    async function SequentialReads() {
      await evaluate(<Include path="brief.md" title={false} />).catch(() => {
        rejected = true
      })
      const recovered = await evaluate(<Include path="brief.md" title={false} />)
      await evaluate(<File path="brief.md">second</File>)
      const changed = await evaluate(<Include path="brief.md" title={false} />)
      return `${recovered}|${changed}`
    }

    await expect(
      new AmlRuntime().evaluate(
        <Sandbox access="read-write" provider={reads.provider}>
          <SequentialReads />
        </Sandbox>
      )
    ).resolves.toBe("first|second")
    expect(rejected).toBe(true)
    expect(reads.readCalls).toEqual(["brief.md", "brief.md", "brief.md"])
  })

  it("evicts the oldest cached file after 32 entries", async () => {
    const files = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`file-${index}.txt`, "oversized"]))
    const reads = instrumentedSandbox({ files })

    async function FillCache() {
      for (let index = 0; index < 33; index += 1) {
        await evaluate(<Include path={`file-${index}.txt`} title={false} />)
      }

      return await evaluate(<Include path="file-0.txt" title={false} />)
    }

    await expect(
      new AmlRuntime().evaluate(
        <Sandbox access="read-only" provider={reads.provider}>
          <FillCache />
        </Sandbox>
      )
    ).resolves.toBe("oversized")
    expect(reads.statCalls).toHaveLength(34)
    expect(reads.readCalls).toHaveLength(34)
  })

  it("retains metadata without content for files larger than the cache limit", async () => {
    const content = `${"x\n".repeat(150_000)}x`
    const reads = instrumentedSandbox({ files: { "large.txt": content } })
    const runtime = new AmlRuntime()

    async function RepeatedLargeInclude() {
      const first = await evaluate(<Include maxBytes={1} path="large.txt" title={false} />)
      const second = await evaluate(<Include maxBytes={1} path="large.txt" title={false} />)
      return `${first}\n${second}`
    }

    const output = await runtime.evaluate(
      <Sandbox access="read-write" provider={reads.provider}>
        <RepeatedLargeInclude />
      </Sandbox>
    )
    expect(output).toContain("File: `large.txt` (293 KiB, 150001 lines)")
    expect(output).toContain("Read it at `large.txt`")
    expect(reads.statCalls).toEqual(["large.txt", "large.txt"])
    expect(reads.readCalls).toEqual([])
    expect(reads.inspectCalls).toEqual(["large.txt"])
  })

  it("preserves read-only Sandbox support without invoking its process boundary", async () => {
    const reads = instrumentedSandbox({ files: { "large.txt": "oversized" } })

    async function RepeatedReadOnlyInclude() {
      await evaluate(<Include maxBytes={1} path="large.txt" title={false} />)
      return await evaluate(<Include maxBytes={1} path="large.txt" title={false} />)
    }

    await new AmlRuntime().evaluate(
      <Sandbox access="read-only" provider={reads.provider}>
        <RepeatedReadOnlyInclude />
      </Sandbox>
    )

    expect(reads.inspectCalls).toEqual([])
    expect(reads.readCalls).toEqual(["large.txt"])
  })

  it("promotes streamed metadata when a later request needs inline content", async () => {
    const reads = instrumentedSandbox({ files: { "brief.md": "shared context" } })

    async function IncludesWithDifferentLimits() {
      const reference = await evaluate(<Include maxBytes={5} path="brief.md" title={false} />)
      const loaded = await evaluate(<Include maxBytes={20} path="brief.md" title={false} />)
      const cached = await evaluate(<Include maxBytes={20} path="brief.md" title={false} />)
      return `${reference}\n${loaded}\n${cached}`
    }

    const output = await new AmlRuntime().evaluate(
      <Sandbox access="read-write" provider={reads.provider}>
        <IncludesWithDifferentLimits />
      </Sandbox>
    )

    expect(output).toContain("File: `brief.md` (14 bytes, 1 line)")
    expect(output.endsWith("shared context\nshared context")).toBe(true)
    expect(reads.statCalls).toEqual(["brief.md", "brief.md", "brief.md"])
    expect(reads.inspectCalls).toEqual(["brief.md"])
    expect(reads.readCalls).toEqual(["brief.md"])
  })

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
              "File: `./large.txt` (10 bytes, 1 line)",
              "",
              `The file exceeds the 4 bytes inline limit. Read it at \`${stagedPath}\`.`,
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

  it("rejects oversized local content that is not valid UTF-8", async () => {
    const directory = await temporaryDirectory("aml-include-binary-stage-")

    try {
      await writeFile(path.join(directory, "binary"), new Uint8Array([0xff, 0xff]))
      await expect(
        new AmlRuntime({ cwd: directory }).evaluate(
          <Agent provider={new DeterministicAgentProvider()}>
            <Include maxBytes={1} src="./binary" title={false} />
          </Agent>
        )
      ).rejects.toThrow("content must be valid UTF-8")
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

  it("stages an oversized host Workspace file at a readable Agent path", async () => {
    const directory = await temporaryDirectory("aml-include-path-limit-")
    const workspace = new DeterministicWorkspaceProvider({ directory })
    let stagedPath = ""
    const provider = new DeterministicAgentProvider({
      async respond(request) {
        stagedPath = /Read it at `([^`]+)`\./.exec(request.prompt)?.[1] ?? ""
        expect(request.prompt).toBe(
          [
            "## Contents of `large.txt`",
            "",
            "File: `large.txt` (10 bytes, 1 line)",
            "",
            `The file exceeds the 4 bytes inline limit. Read it at \`${stagedPath}\`.`,
          ].join("\n")
        )
        expect(await readFile(stagedPath, "utf8")).toBe("0123456789")
        return { text: "done" }
      },
    })

    try {
      await writeFile(path.join(directory, "large.txt"), "0123456789")
      await expect(
        new AmlRuntime().evaluate(
          <Workspace id="include-path-limit" provider={workspace}>
            <Agent provider={provider}>
              <Include maxBytes={4} path="large.txt" />
            </Agent>
          </Workspace>
        )
      ).resolves.toBe("done")
      expect(stagedPath).toContain(`${path.sep}.aml${path.sep}includes${path.sep}`)
      await expect(access(stagedPath)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("references an oversized Sandbox file relative to the effective Agent cwd", async () => {
    const sandbox = new DeterministicSandboxProvider()
    const provider = new DeterministicAgentProvider({
      async respond(request, context) {
        const readablePath = /Read it at `([^`]+)`\./.exec(request.prompt)?.[1] ?? ""
        expect(request.prompt).toBe(
          [
            "## Contents of `large.txt`",
            "",
            "File: `large.txt` (10 bytes, 1 line)",
            "",
            "The file exceeds the 4 bytes inline limit. Read it at `../large.txt`.",
          ].join("\n")
        )
        expect(context.sandbox?.cwd).toBe("nested")
        const resolvedPath = path.posix.normalize(path.posix.join(context.sandbox?.cwd ?? ".", readablePath))
        expect(new TextDecoder().decode(await context.sandbox?.lease.runtime.readFile(resolvedPath))).toBe("0123456789")
        return { text: "done" }
      },
      supportsSandbox: () => true,
    })

    await expect(
      new AmlRuntime().evaluate(
        <Sandbox access="read-write" cwd="nested" provider={sandbox}>
          <File path="large.txt">0123456789</File>
          <Agent provider={provider}>
            <Include maxBytes={4} path="large.txt" />
          </Agent>
        </Sandbox>
      )
    ).resolves.toBe("done")
  })

  it("rejects missing scope, oversized source without an Agent, inline invalid UTF-8, and invalid props", async () => {
    const directory = await temporaryDirectory("aml-include-invalid-")
    const runtime = new AmlRuntime({ cwd: directory })

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
      await expect(
        runtime.evaluate(
          <Workspace id="include-path-without-agent" provider={new DeterministicWorkspaceProvider({ directory })}>
            <Include maxBytes={4} path="large.txt" />
          </Workspace>
        )
      ).rejects.toThrow("an oversized <Include> requires a containing <Agent>")
      await expect(runtime.evaluate(<Include src="./binary" />)).rejects.toThrow("must be valid UTF-8")
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

function instrumentedSandbox(options: {
  readonly delayMs?: number
  readonly failFirstRead?: boolean
  readonly files: Readonly<Record<string, string>>
}) {
  const base = new DeterministicSandboxProvider()
  const files = new Map(Object.entries(options.files))
  const revisions = new Map(Array.from(files.keys(), filePath => [filePath, 0]))
  const inspectCalls: string[] = []
  const readCalls: string[] = []
  const statCalls: string[] = []
  let shouldFailRead = options.failFirstRead ?? false
  const provider: SandboxProvider = {
    name: "instrumented-sandbox",
    async acquire(request) {
      const lease = await base.acquire(request)
      const runtime = lease.runtime

      return Object.freeze({
        ...lease,
        runtime: Object.freeze({
          ...runtime,
          async readFile(filePath: string, readOptions = {}) {
            readCalls.push(filePath)
            await delay(options.delayMs)

            if (shouldFailRead) {
              shouldFailRead = false
              throw new Error("temporary read failure")
            }

            const content = files.get(filePath)
            return content === undefined
              ? await runtime.readFile(filePath, readOptions)
              : new TextEncoder().encode(content)
          },
          async spawn(command: string, args = [], spawnOptions: Readonly<SandboxExecOptions> = {}) {
            if (command !== "cat" || args.length !== 1) return await runtime.spawn(command, args, spawnOptions)
            const filePath = path.posix.normalize(path.posix.join(spawnOptions.cwd ?? request.cwd, args[0]!))
            const content = files.get(filePath)
            if (content === undefined) return await runtime.spawn(command, args, spawnOptions)
            inspectCalls.push(filePath)
            return textProcess(content)
          },
          async stat(filePath: string, statOptions = {}) {
            statCalls.push(filePath)
            await delay(options.delayMs)
            const content = files.get(filePath)
            return content === undefined
              ? await runtime.stat(filePath, statOptions)
              : Object.freeze({
                  kind: "file" as const,
                  modifiedAtMs: revisions.get(filePath) ?? 0,
                  size: new TextEncoder().encode(content).byteLength,
                })
          },
          async writeFile(filePath: string, content: Uint8Array, writeOptions = {}) {
            files.set(filePath, new TextDecoder().decode(content))
            revisions.set(filePath, (revisions.get(filePath) ?? 0) + 1)
            await runtime.writeFile(filePath, content, writeOptions)
          },
        }),
      })
    },
  }

  return { inspectCalls, provider, readCalls, statCalls }
}

async function delay(milliseconds = 1): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds))
}

function textProcess(content: string) {
  const bytes = new TextEncoder().encode(content)
  return Object.freeze({
    id: "include-cat",
    async kill() {},
    stdin: new WritableStream<Uint8Array>(),
    stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
    async wait() {
      return Object.freeze({ exitCode: 0 })
    },
  })
}
