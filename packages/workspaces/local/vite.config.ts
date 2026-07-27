import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, "src/index.ts"),
      fileName: () => "index.js",
      formats: ["es"],
    },
    rolldownOptions: {
      external: [
        /^node:/,
        /^@aml\/sdk(?:\/.*)?$/,
        /^proper-lockfile$/,
      ],
      output: {
        minifyInternalExports: false,
      },
    },
    sourcemap: true,
    target: "es2022",
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
})
