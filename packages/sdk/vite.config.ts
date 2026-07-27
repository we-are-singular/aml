import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  // Vite injects automatic-runtime imports after normal alias resolution.
  // An absolute SDK-local import source keeps TSX off stale or missing dist.
  oxc: {
    jsx: {
      importSource: resolve(import.meta.dirname, "src"),
      runtime: "automatic",
    },
  },
  resolve: {
    conditions: ["aml-source"],
  },
  build: {
    emptyOutDir: true,
    lib: {
      entry: {
        index: resolve(import.meta.dirname, "src/index.ts"),
        "jsx-dev-runtime": resolve(
          import.meta.dirname,
          "src/jsx-dev-runtime.ts",
        ),
        "jsx-runtime": resolve(import.meta.dirname, "src/jsx-runtime.ts"),
        testing: resolve(import.meta.dirname, "src/testing.ts"),
      },
      fileName: (_format, entryName) => `${entryName}.js`,
      formats: ["es"],
    },
    rolldownOptions: {
      // AmlRuntime's local Skill imports remain Node runtime boundaries;
      // bundling shims would obscure the SDK's actual platform requirement.
      external: [/^node:/],
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
