import { dirname } from "node:path"
import { env as processEnv } from "node:process"

import { createServer } from "vite"
import { ViteNodeRunner } from "vite-node/client"
import { ViteNodeServer } from "vite-node/server"
import { installSourcemapsSupport } from "vite-node/source-map"

export interface WorkflowModule {
  readonly [exportName: string]: unknown
}

/** Loads one trusted workflow module through the same Vite lifecycle used by vite-node. */
export async function loadWorkflowModule(filePath: string): Promise<WorkflowModule> {
  const server = await createServer({
    appType: "custom",
    logLevel: "error",
    mode: processEnv.NODE_ENV ?? "development",
    optimizeDeps: {
      // A one-shot command does not benefit from dependency discovery or a file watcher.
      noDiscovery: true,
    },
    root: dirname(filePath),
    server: {
      watch: null,
    },
  })

  try {
    await server.environments.client.pluginContainer.buildStart({})

    const node = new ViteNodeServer(server)
    installSourcemapsSupport({
      getSourceMap: source => node.getSourceMap(source),
    })

    const runner = new ViteNodeRunner({
      base: server.config.base,
      fetchModule: id => node.fetchModule(id),
      resolveId: (id, importer) => node.resolveId(id, importer),
      root: server.config.root,
    })

    // ViteNodeRunner already proxies import.meta.env to process.env. Its client-only
    // /@vite/env bootstrap resolves as a filesystem module in packed Windows installs.
    return (await runner.executeFile(filePath)) as WorkflowModule
  } finally {
    await server.close()
  }
}
