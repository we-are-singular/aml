import assert from "node:assert/strict"
import { test } from "node:test"

import { assertBuilderSupportsAttestations, parseBuilderInspection, usesContainerdImageStore } from "./publish.mjs"
import { createReleaseEnvironment } from "./release.mjs"

test("isolates Docker credentials while preserving caller Buildx state", () => {
  const environment = createReleaseEnvironment(
    { DOCKER_CONFIG: "/caller/docker", BUILDX_BUILDER: "publisher" },
    prefix => `${prefix}temporary`
  )

  assert.equal(environment.DOCKER_CONFIG.endsWith("temporary"), true)
  assert.equal(environment.BUILDX_CONFIG, "/caller/docker/buildx")
  assert.equal(environment.BUILDX_BUILDER, "publisher")
})

test("preserves an explicit Buildx configuration directory", () => {
  const environment = createReleaseEnvironment({ BUILDX_CONFIG: "/caller/buildx" }, prefix => `${prefix}temporary`)

  assert.equal(environment.BUILDX_CONFIG, "/caller/buildx")
})

test("reads the current builder driver and every BuildKit node version", () => {
  assert.deepEqual(
    parseBuilderInspection(
      `Name: publisher\nDriver: docker-container\nBuildKit version: v0.12.5\nBuildKit version: v0.13.2\n`
    ),
    {
      buildkitVersions: ["0.12.5", "0.13.2"],
      driver: "docker-container",
      name: "publisher",
    }
  )
})

test("recognizes Docker's documented containerd image-store marker", () => {
  assert.equal(usesContainerdImageStore({ DriverStatus: [["driver-type", "io.containerd.snapshotter.v1"]] }), true)
  assert.equal(usesContainerdImageStore({ DriverStatus: [["Backing Filesystem", "extfs"]] }), false)
})

test("rejects the Docker classic image store with actionable alternatives", () => {
  assert.throws(
    () =>
      assertBuilderSupportsAttestations(
        { buildkitVersions: ["0.30.0"], driver: "docker", name: "default" },
        { DriverStatus: [["Backing Filesystem", "extfs"]] }
      ),
    /Select an existing docker-container builder.*or enable Docker's containerd image store/
  )
})

test("accepts a current docker-container builder", () => {
  assert.doesNotThrow(() =>
    assertBuilderSupportsAttestations({
      buildkitVersions: ["0.32.2"],
      driver: "docker-container",
      name: "publisher",
    })
  )
})
