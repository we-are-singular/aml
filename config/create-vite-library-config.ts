import { resolve } from "node:path"

import { defineConfig } from "vitest/config"

/**
 * Defines the common single-entry ESM package build used by AML adapters.
 *
 * Concrete packages keep their dependency externals visible at the call site;
 * this helper owns only the repository-wide output and test policy.
 */
export function createViteLibraryConfig(options: {
  readonly directory: string
  readonly external: readonly (RegExp | string)[]
}) {
  return defineConfig({
    build: {
      emptyOutDir: true,
      lib: {
        entry: resolve(options.directory, "src/index.ts"),
        fileName: () => "index.js",
        formats: ["es"],
      },
      rolldownOptions: {
        external: [/^node:/, /^@aml-jsx\/sdk(?:\/.*)?$/, ...options.external],
        output: {
          minifyInternalExports: false,
        },
      },
      sourcemap: true,
      target: "es2022",
    },
    test: {
      include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    },
  })
}
