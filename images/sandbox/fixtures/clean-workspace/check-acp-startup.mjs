// Initializes installed GLM/Pi adapters offline to exercise their ACP schema dependencies.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import process from "node:process"
import { createInterface } from "node:readline"
import { clearTimeout, setTimeout } from "node:timers"

const require = createRequire(import.meta.url)
const commands = process.argv.slice(2).filter(command => command === "glm-acp-agent" || command === "pi-acp")

for (const command of commands) {
  const manifestPath = require.resolve(`${command}/package.json`)
  const manifest = require(manifestPath)
  const directory = await mkdtemp(join(tmpdir(), "aml-acp-startup-"))
  // Use Node directly so npm's Windows command shims are not part of the probe.
  const child = spawn(process.execPath, [join(dirname(manifestPath), manifest.bin[command])], {
    cwd: directory,
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      HOME: directory,
      USERPROFILE: directory,
      XDG_CONFIG_HOME: directory,
      XDG_DATA_HOME: directory,
      XDG_STATE_HOME: directory,
      XDG_CACHE_HOME: directory,
      PI_CODING_AGENT_DIR: join(directory, "pi"),
      ACP_GLM_SESSION_DIR: join(directory, "glm"),
    },
    stdio: "pipe",
  })
  const lines = createInterface({ input: child.stdout })
  let stderr = ""
  let timer
  child.stderr.on("data", chunk => {
    stderr = (stderr + chunk).slice(-16_384)
  })

  try {
    const response = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.stdin.on("error", reject)
      child.once("close", code => reject(new Error(`${command} exited ${code} before initialization: ${stderr}`)))
      timer = setTimeout(() => reject(new Error(`${command} initialization timed out: ${stderr}`)), 30_000)
      lines.on("line", line => {
        try {
          const message = JSON.parse(line)
          if (message.id === 1) resolve(message)
        } catch (error) {
          reject(error)
        }
      })
      // No session or prompt is created: initialization validates ACP schemas without a model key.
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: 1, clientCapabilities: {} },
        })}\n`
      )
    })
    assert.equal(response.error, undefined, JSON.stringify(response.error))
    assert.equal(response.result.protocolVersion, 1)
    assert.equal(typeof response.result.agentCapabilities, "object")
    process.stdout.write(`Initialized ${command} without credentials\n`)
  } finally {
    clearTimeout(timer)
    lines.close()
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close")
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000)
      child.kill()
      await closed
      clearTimeout(killTimer)
    }
    await rm(directory, { recursive: true, force: true })
  }
}
