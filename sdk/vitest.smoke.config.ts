import { defineConfig } from "vitest/config"

import baseConfig from "./vite.config.js"

/**
 * Smoke files are intentionally outside the default unit-test include.
 * Vitest positional filters do not override that include boundary.
 */
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    fileParallelism: false,
    hookTimeout: 300_000,
    include: ["tests/smoke/**/*.smoke.ts", "tests/smoke/**/*.smoke.tsx"],
    testTimeout: 300_000,
  },
})
