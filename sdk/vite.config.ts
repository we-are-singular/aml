import { resolve } from "node:path"
import { defineConfig } from "vitest/config"
import dts from "vite-plugin-dts"

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
    alias: {
      "@aml-jsx/agent-codex": resolve(import.meta.dirname, "../providers/agents/codex/src/index.ts"),
      "@aml-jsx/agent-opencode": resolve(import.meta.dirname, "../providers/agents/opencode/src/index.ts"),
      "@aml-jsx/agent-pi": resolve(import.meta.dirname, "../providers/agents/pi/src/index.ts"),
      "@aml-jsx/sandbox-docker": resolve(import.meta.dirname, "../providers/sandboxes/docker/src/index.ts"),
      "@aml-jsx/sandbox-daytona": resolve(import.meta.dirname, "../providers/sandboxes/daytona/src/index.ts"),
      "@aml-jsx/sandbox-local": resolve(import.meta.dirname, "../providers/sandboxes/local/src/index.ts"),
      "@aml-jsx/sdk": resolve(import.meta.dirname, "src/core.ts"),
      "@aml-jsx/workspace-local": resolve(import.meta.dirname, "../providers/workspaces/local/src/index.ts"),
    },
    conditions: ["aml-source"],
  },
  plugins: [
    dts({
      entryRoot: resolve(import.meta.dirname, ".."),
      include: [
        "src",
        "../providers/agents/codex/src",
        "../providers/agents/opencode/src",
        "../providers/agents/pi/src",
        "../providers/sandboxes/docker/src",
        "../providers/sandboxes/daytona/src",
        "../providers/sandboxes/local/src",
        "../providers/workspaces/local/src",
      ],
      tsconfigPath: resolve(import.meta.dirname, "tsconfig.build.json"),
    }),
  ],
  build: {
    emptyOutDir: true,
    lib: {
      entry: {
        index: resolve(import.meta.dirname, "src/index.ts"),
        "jsx-dev-runtime": resolve(import.meta.dirname, "src/jsx-dev-runtime.ts"),
        "jsx-runtime": resolve(import.meta.dirname, "src/jsx-runtime.ts"),
        testing: resolve(import.meta.dirname, "src/testing.ts"),
      },
      fileName: (_format, entryName) => `${entryName}.js`,
      formats: ["es"],
    },
    rolldownOptions: {
      // AmlRuntime's local Skill imports remain Node runtime boundaries;
      // bundling shims would obscure the SDK's actual platform requirement.
      external: [
        /^node:/,
        /^@modelcontextprotocol\/sdk(?:\/.*)?$/,
        /^@daytona\/sdk(?:\/.*)?$/,
        /^@earendil-works\/pi-coding-agent(?:\/.*)?$/,
        /^@openai\/codex-sdk$/,
        /^@opencode-ai\/sdk(?:\/.*)?$/,
        /^execa$/,
        /^proper-lockfile$/,
        /^typebox(?:\/.*)?$/,
      ],
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
