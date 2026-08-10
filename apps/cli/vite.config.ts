import { defineConfig } from "vite"
import { builtinModules } from "node:module"
import { resolve } from "node:path"
import pkg from "./package.json"

const nodeExternal = [...builtinModules, ...builtinModules.map(moduleName => `node:${moduleName}`)]

function isViteNodeDependency(id: string): boolean {
  return id === "vite-node" || id.startsWith("vite-node/") || id.includes("/vite-node/")
}

export default defineConfig({
  define: {
    // Injected at build time from package.json, avoiding runtime JSON reads.
    __CLI_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      external: id => {
        if (id.startsWith("\u0000")) {
          return false
        }

        return nodeExternal.includes(id) || isViteNodeDependency(id)
      },
      output: {
        // Match current Rollup/Vite guidance for single-file CLI output.
        codeSplitting: false,
        banner: "#!/usr/bin/env node",
      },
    },
    minify: true,
    sourcemap: false,
    target: "node26",
  },
})
