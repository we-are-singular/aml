import { createViteLibraryConfig } from "../../../config/create-vite-library-config.js"

export default createViteLibraryConfig({
  directory: import.meta.dirname,
  external: [/^@modelcontextprotocol\/sdk(?:\/.*)?$/, /^@opencode-ai\/sdk(?:\/.*)?$/, /^execa$/],
})
