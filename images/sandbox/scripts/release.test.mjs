import assert from "node:assert/strict"
import test from "node:test"

import { parseBuildxDriver } from "./release.mjs"

test("parses the legacy Docker driver", () => {
  assert.equal(parseBuildxDriver("Name: default\nDriver: docker\n"), "docker")
})

test("parses attestation-capable Buildx drivers", () => {
  assert.equal(parseBuildxDriver("Name: publisher\nDriver: docker-container\n"), "docker-container")
  assert.equal(parseBuildxDriver("Name: remote\nDriver: remote\n"), "remote")
  assert.equal(parseBuildxDriver("Name: cloud\nDriver: cloud\n"), "cloud")
})

test("rejects inspect output without a driver", () => {
  assert.throws(() => parseBuildxDriver("Name: unavailable\n"), /did not report its selected driver/)
})
