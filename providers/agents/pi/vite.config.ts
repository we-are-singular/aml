import { createViteLibraryConfig } from "../../../config/create-vite-library-config.js"

export default createViteLibraryConfig({
  directory: import.meta.dirname,
  external: [/^@earendil-works\/pi-coding-agent(?:\/.*)?$/, /^typebox(?:\/.*)?$/],
})
