import { resolve } from "node:path"

import { mergeConfig } from "vitest/config"

import { createViteLibraryConfig } from "../../../config/create-vite-library-config.js"

export default mergeConfig(
  createViteLibraryConfig({
    directory: import.meta.dirname,
    external: [/^@aws-sdk\/client-s3$/],
  }),
  {
    test: {
      // Vitest collects the disabled MinIO suite before skipIf runs. Resolve
      // its dev-only Sandbox dependency without requiring a prebuilt dist.
      alias: {
        "@aml-jsx/sandbox-local": resolve(import.meta.dirname, "../../sandboxes/local/src/index.ts"),
      },
    },
  }
)
