import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { URL } from "node:url"

import {
  agentVariants,
  getVariant,
  immutableTags,
  movingTags,
  selectVariantDependencies,
  variantNames,
} from "./variants.mjs"

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

test("full contains every image dependency and Agent command", () => {
  const full = getVariant("full")
  assert.deepEqual([...full.dependencies].sort(), Object.keys(manifest.dependencies).sort())
  assert.deepEqual(
    full.commands,
    Object.values(agentVariants).flatMap(variant => variant.commands)
  )
})

test("an Agent variant retains common and selected dependencies only", () => {
  const selected = selectVariantDependencies(manifest, "opencode")
  assert.deepEqual(Object.keys(selected.dependencies), ["@aml-jsx/cli", "@aml-jsx/sdk", "opencode-ai"])
  assert.deepEqual(getVariant("opencode").commands, ["opencode"])
})

test("variants expose stable and moving tags", () => {
  assert.deepEqual(variantNames, ["full", "codex", "copilot", "glm", "opencode", "pi"])
  assert.deepEqual(immutableTags("0.4.0", "full"), ["0.4.0", "0.4.0-full"])
  assert.deepEqual(movingTags("full"), ["latest", "full"])
  assert.deepEqual(immutableTags("0.4.0", "opencode"), ["0.4.0-opencode"])
  assert.deepEqual(movingTags("opencode"), ["opencode"])
})

test("unknown variants fail clearly", () => {
  assert.throws(() => getVariant("unknown"), /Unknown image variant/)
})
