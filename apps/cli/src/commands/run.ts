import { createServer } from "vite"
import { createConsoleTracer, type AmlRenderable, AmlRuntime } from "@aml-jsx/sdk"
import { ViteNodeRunner } from "vite-node/client"
import { ViteNodeServer } from "vite-node/server"
import { installSourcemapsSupport } from "vite-node/source-map"
import { Command, Option } from "clipanion"
import { createHash } from "node:crypto"
import { stderr, stdout } from "node:process"
import { performance } from "node:perf_hooks"
import { constants, existsSync } from "node:fs"
import { access, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { applyWorkflowEnv } from "../env.js"

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function getRunIdFallback(filePath: string): string {
  return createHash("sha1").update(filePath).digest("hex").slice(0, 8)
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then: unknown }).then === "function"
  )
}

function isAmlRenderable(value: unknown): value is AmlRenderable {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value) ||
    isAmlNode(value)
  ) {
    return true
  }

  return false
}

function isAmlNode(value: unknown): value is AmlRenderable {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value as Record<string, unknown>, "$$typeof") &&
    (value as Record<string, unknown>)["$$typeof"] === Symbol.for("@aml-jsx/sdk/node")
  )
}

function normalizeExportName(available: readonly string[]): string[] {
  return [...available].sort()
}

async function loadWorkflowModule(filePath: string): Promise<ModuleLike> {
  const server = await createServer({
    appType: "custom",
    logLevel: "error",
    root: dirname(filePath),
    optimizeDeps: {
      // Avoid dependency discovery cost for CLI execution.
      noDiscovery: true,
    },
  })

  const node = new ViteNodeServer(server)
  installSourcemapsSupport({
    getSourceMap: source => node.getSourceMap(source),
  })

  const runner = new ViteNodeRunner({
    root: server.config.root,
    base: server.config.base,
    resolveId(id, importer) {
      return node.resolveId(id, importer)
    },
    fetchModule(id) {
      return node.fetchModule(id)
    },
  })

  try {
    const module = await runner.executeFile(filePath)
    return module
  } finally {
    await server.close()
  }
}

interface ModuleLike {
  [exportName: string]: unknown
}

function resolveWorkflowExport(module: ModuleLike, requestedExport: string | undefined, filePath: string): unknown {
  if (requestedExport !== undefined) {
    if (!(requestedExport in module)) {
      throw new TypeError(
        `file "${filePath}" does not export "${requestedExport}". Available exports: ${normalizeExportName(
          Object.keys(module)
        ).join(", ")}`
      )
    }

    return module[requestedExport]
  }

  if ("default" in module) {
    return module.default
  }

  if (typeof module.main === "function") {
    return module.main
  }

  throw new TypeError(
    `file "${filePath}" must export either "default" or "main()". ` +
      `No compatible export was found. Available: ${normalizeExportName(Object.keys(module)).join(", ")}`
  )
}

interface CliRunResult {
  readonly result: string
  readonly runId: string
  readonly durationMs: number
}

async function executeWorkflow(
  filePath: string,
  exportName: string | undefined,
  envFilePath: string | undefined,
  enableTrace: boolean,
  captureTraceContent: boolean
): Promise<CliRunResult> {
  if (existsSync(filePath) === false) {
    throw new Error(`file not found: ${filePath}`)
  }

  const resolvedPath = resolve(filePath)
  const stats = await stat(resolvedPath)
  if (!stats.isFile()) {
    throw new Error(`not a file: ${resolvedPath}`)
  }

  await access(resolvedPath, constants.R_OK)
  const runIdFallback = getRunIdFallback(resolvedPath)
  await applyWorkflowEnv(resolvedPath, envFilePath)

  const startTime = performance.now()
  const mod = await loadWorkflowModule(resolvedPath)
  const selectedExport = resolveWorkflowExport(mod, exportName, resolvedPath)

  let workflow: unknown = selectedExport
  if (typeof workflow === "function") {
    workflow = await workflow()
  }

  if (isThenable(workflow)) {
    workflow = await workflow
  }

  if (!isAmlRenderable(workflow)) {
    throw new TypeError(
      `export from "${resolvedPath}" must resolve to an AML renderable (for example, JSX, string, number, boolean, undefined, or AmlNode), ` +
        `but got "${typeof workflow}".`
    )
  }

  const runtime = new AmlRuntime()

  let runId: string | undefined
  const startedAt = Date.now()
  runtime.on("start", ({ runId: activeRunId }) => {
    runId = activeRunId
    stderr.write(`aml: starting run ${activeRunId} for ${resolvedPath}\n`)
  })
  runtime.on("finish", ({ status, error }) => {
    const finalStatus = status === "ok" ? "ok" : "error"
    stderr.write(`aml: finished run ${runId ?? runIdFallback} (${finalStatus}) in ${Date.now() - startedAt}ms\n`)
    if (status === "error" && error !== undefined) {
      stderr.write(`aml: evaluation error: ${getErrorMessage(error)}\n`)
    }
  })

  if (enableTrace) {
    runtime.on(
      "trace",
      createConsoleTracer({ captureContent: captureTraceContent, write: line => stderr.write(`${line}\n`) })
    )
  }

  const result = await runtime.evaluate(workflow as AmlRenderable)
  const durationMs = performance.now() - startTime

  return {
    durationMs,
    result,
    runId: runId ?? runIdFallback,
  }
}

export class RunCommand extends Command {
  static override paths = [["run"]]

  static override usage = Command.Usage({
    description: "Execute one AML workflow file with live instrumentation.",
    details:
      "Loads a TypeScript/TSX/JS source file using Vite's transform pipeline and executes either its default export " +
      "or an exported main() function. By default the CLI prints only the workflow result to stdout and sends logs to stderr.",
    examples: [
      ["Execute a workflow from the default export", "aml run ./examples/src/core/agent.tsx"],
      ["Execute a named export", "aml run ./workflow.ts --entry main"],
      ["Enable trace output", "aml run ./workflow.tsx --trace"],
      ["Show prompt content in trace output", "aml run ./workflow.tsx --trace --capture-content"],
    ],
  })

  workflowFile = Option.String()
  entry = Option.String("-e,--entry", {
    description: "Export name to execute; defaults to default, then main()",
    required: false,
  })
  envFile = Option.String("--runtime-env-file", {
    description: "Optional env file to apply after Vite env loading",
    required: false,
  })
  trace = Option.Boolean("--trace", false, {
    description: "Print execution trace events to stderr",
  })
  captureTraceContent = Option.Boolean("--capture-content", false, {
    description: "Include prompts/content in trace output (implies --trace)",
  })
  json = Option.Boolean("--json", false, {
    description: "Emit result envelope as JSON",
  })

  override async execute(): Promise<number> {
    const fileArg = this.workflowFile
    if (fileArg === undefined) {
      stderr.write("aml run expects a workflow file.\n")
      return 1
    }

    try {
      const outcome = await executeWorkflow(
        fileArg,
        this.entry,
        this.envFile,
        this.trace || this.captureTraceContent,
        this.captureTraceContent
      )

      if (this.json) {
        const payload = JSON.stringify(
          {
            runId: outcome.runId,
            durationMs: Math.round(outcome.durationMs * 10) / 10,
            success: true,
            result: outcome.result,
          },
          null,
          2
        )
        stdout.write(`${payload}\n`)
      } else {
        stdout.write(`${outcome.result}\n`)
      }

      return 0
    } catch (error) {
      stderr.write(`aml: ${getErrorMessage(error)}\n`)
      return 1
    }
  }
}
