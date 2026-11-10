import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"
import { URL } from "node:url"

import { signingTerminal } from "./publish.mjs"

const supportsControllingPty =
  process.platform === "linux" && spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0

test("an inherited TTY remains owned by the caller", async () => {
  const input = { isTTY: true }
  const output = {}
  const terminal = signingTerminal(input, output, () => assert.fail("should use the inherited terminal"))
  assert.equal(terminal.input, input)
  assert.equal(terminal.output, output)
  await terminal.close()
})

test("a missing controlling terminal reports the interactive signing requirement", () => {
  const cause = new Error("terminal unavailable")
  assert.throws(
    () =>
      signingTerminal({ isTTY: false }, {}, () => {
        throw cause
      }),
    error => error.message === "Cosign signing requires an interactive terminal" && error.cause === cause
  )
})

test(
  "controlling terminal cleanup closes both streams without double-closing their descriptor",
  { skip: !supportsControllingPty },
  () => {
    // Linux's script utility supplies a real controlling PTY even when the test runner uses pipes.
    const directory = mkdtempSync(join(tmpdir(), "aml-signing-terminal-"))
    try {
      const publisher = new URL("./publish.mjs", import.meta.url).href
      writeFileSync(
        join(directory, "check.mjs"),
        `
      import assert from "node:assert/strict"
      import { signingTerminal } from ${JSON.stringify(publisher)}
      for (let index = 0; index < 3; index += 1) {
        const terminal = signingTerminal({ isTTY: false }, {})
        await terminal.close()
        assert.equal(terminal.input.closed, true)
        assert.equal(terminal.output.closed, true)
      }
      console.log("terminal cleanup passed")
    `
      )
      const result = spawnSync("script", ["-q", "-e", "-c", "node check.mjs", "/dev/null"], {
        cwd: directory,
        encoding: "utf8",
        timeout: 10_000,
      })
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /terminal cleanup passed/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
