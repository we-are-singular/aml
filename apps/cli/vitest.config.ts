import { defineConfig } from "vitest/config"

/**
 * Integration tests spawn the compiled CLI with spawnSync, which allows each
 * subprocess 30s. Cold CI runners pay several seconds of node startup per
 * spawn and exceed vitest's 5s default before the page cache warms up.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
})
