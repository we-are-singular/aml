import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import process from "node:process"
import readline from "node:readline/promises"
import test from "node:test"
import { fileURLToPath, URL } from "node:url"

import { variantNames } from "./variants.mjs"

const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version
const imageDigest = `sha256:${"a".repeat(64)}`
let invocation = 0

/** Runs the real script flow with Docker, registries, release tools, and signing prompts stubbed. */
async function runScript(t, script, args, { noSmoke = false, failImageCheck = false, calls = [] } = {}) {
  const previousArguments = process.argv
  const previousExitCode = process.exitCode
  const previousNoSmoke = process.env.AML_SANDBOX_NO_SMOKE
  const previousTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
  const scriptUrl = new URL(script, import.meta.url)
  process.argv = [process.execPath, fileURLToPath(scriptUrl), ...args]
  process.env.AML_SANDBOX_NO_SMOKE = noSmoke ? "1" : "0"
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })

  const commandMock = t.mock.method(childProcess, "spawnSync", (command, commandArguments, options = {}) => {
    calls.push({ command, args: commandArguments, noSmoke: options.env?.AML_SANDBOX_NO_SMOKE })
    let stdout = ""
    if (command === "git") {
      if (commandArguments[0] === "branch") stdout = "main"
      if (commandArguments[0] === "rev-parse") stdout = "test-revision"
      if (commandArguments[0] === "tag") stdout = `sandbox-v${packageVersion}`
    }
    if (command === "gh" && commandArguments[0] === "auth") stdout = "test-token"
    if (command === "docker" && commandArguments[1] === "inspect") stdout = "Driver: docker-container\n"
    if (command === "docker" && commandArguments[1] === "imagetools") stdout = imageDigest
    if (command === "docker" && commandArguments[1] === "build") {
      const metadataPath = commandArguments[commandArguments.indexOf("--metadata-file") + 1]
      writeFileSync(metadataPath, JSON.stringify({ "containerimage.digest": imageDigest }))
    }
    const fails = failImageCheck && command === "node" && commandArguments[0] === "scripts/check.mjs"
    return { status: fails ? 1 : 0, stdout, stderr: "" }
  })
  const promptMock = t.mock.method(readline, "createInterface", () => ({ question: async () => "", close() {} }))
  syncBuiltinESMExports()

  try {
    // A fresh module captures this invocation's CLI options without executing its entrypoint twice.
    scriptUrl.searchParams.set("testInvocation", String(++invocation))
    const scriptModule = await import(scriptUrl.href)
    await scriptModule.main()
    return { calls, exitCode: process.exitCode }
  } finally {
    commandMock.mock.restore()
    promptMock.mock.restore()
    syncBuiltinESMExports()
    process.argv = previousArguments
    process.exitCode = previousExitCode
    if (previousNoSmoke === undefined) delete process.env.AML_SANDBOX_NO_SMOKE
    else process.env.AML_SANDBOX_NO_SMOKE = previousNoSmoke
    if (previousTty === undefined) delete process.stdin.isTTY
    else Object.defineProperty(process.stdin, "isTTY", previousTty)
  }
}

for (const noSmoke of [false, true]) {
  test(`publication ${noSmoke ? "skips live smoke" : "runs live smoke by default"} and preserves image checks and signing`, async t => {
    const { calls } = await runScript(t, "publish.mjs", [packageVersion], { noSmoke })
    const builds = calls.filter(call => call.command === "docker" && call.args[1] === "build")
    const checks = calls.filter(call => call.command === "node" && call.args[0] === "scripts/check.mjs")
    const smoke = calls.filter(call => call.command === "npm" && call.args[1] === "smoke")
    const signatures = calls.filter(call => call.command === "cosign")
    const aliases = calls.filter(call => call.command === "docker" && call.args[2] === "create")

    assert.equal(builds.length, variantNames.length)
    assert.deepEqual(
      checks.map(call => call.args[1]),
      variantNames
    )
    assert.equal(smoke.length, noSmoke ? 0 : variantNames.length)
    assert.equal(signatures.length, variantNames.length)
    assert.equal(aliases.length, variantNames.length + 1)
    assert.ok(builds.every(call => call.args.includes("--sbom=true") && call.args.includes("--provenance=mode=max")))
    assert.ok(calls.indexOf(signatures[0]) > calls.indexOf(checks.at(-1)))
    assert.ok(calls.indexOf(aliases[0]) > calls.indexOf(signatures.at(-1)))
  })
}

test("a failed offline check still prevents signing and moving tags with --no-smoke", async t => {
  const calls = []
  await assert.rejects(
    runScript(t, "publish.mjs", [packageVersion], { noSmoke: true, failImageCheck: true, calls }),
    /node exited with status 1/
  )
  assert.equal(
    calls.some(call => call.command === "cosign"),
    false
  )
  assert.equal(
    calls.some(call => call.command === "docker" && call.args[2] === "create"),
    false
  )
})

test("--no-smoke is consumed by the wrapper and passed through the Release It hook environment", async t => {
  const { calls, exitCode } = await runScript(t, "release.mjs", ["--no-smoke", "patch"])
  const release = calls.find(call => call.command === "release-it")
  assert.equal(exitCode, 0)
  assert.deepEqual(release.args, ["patch"])
  assert.equal(release.noSmoke, "1")
})

test("normal releases enable live smoke even if an inherited environment requests skipping", async t => {
  const { calls, exitCode } = await runScript(t, "release.mjs", [], { noSmoke: true })
  assert.equal(exitCode, 0)
  assert.equal(calls.find(call => call.command === "release-it").noSmoke, "0")
})

test("--no-smoke also reaches publication during recovery", async t => {
  const { calls, exitCode } = await runScript(t, "release.mjs", ["--recover", "--no-smoke"])
  const publisher = calls.find(call => call.command === "node" && call.args[1] === packageVersion)
  assert.equal(exitCode, 0)
  assert.deepEqual(publisher.args, ["scripts/publish.mjs", packageVersion])
  assert.equal(publisher.noSmoke, "1")
})

test("--no-smoke is not forwarded to Release It during previews", async t => {
  const { calls, exitCode } = await runScript(t, "release.mjs", ["--dry-run", "--no-smoke"])
  assert.equal(exitCode, 0)
  assert.deepEqual(calls.find(call => call.command === "release-it").args, ["--dry-run"])
  assert.equal(
    calls.some(call => call.command === "docker"),
    false
  )
})
