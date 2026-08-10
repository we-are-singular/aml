import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { performance } from "node:perf_hooks"
import { resolve } from "node:path"

import { AmlRuntime, createConsoleTracer, type AmlRenderable } from "@aml-jsx/sdk"

import { applyWorkflowEnv } from "./env.js"
import { loadWorkflowModule, type WorkflowModule } from "./workflow-loader.js"

export interface WorkflowRunOptions {
  readonly captureTraceContent: boolean
  readonly enableTrace: boolean
  readonly envFilePath?: string
  readonly exportName?: string
  readonly filePath: string
  readonly signal?: AbortSignal
  readonly writeDiagnostic: (line: string) => void
}

export interface WorkflowRunResult {
  readonly durationMs: number
  readonly result: string
  readonly runId: string
}

function listExports(module: WorkflowModule): string {
  const names = Object.keys(module).sort()
  return names.length === 0 ? "none" : names.join(", ")
}

export function resolveWorkflowExport(
  module: WorkflowModule,
  requestedExport: string | undefined,
  filePath: string
): unknown {
  if (requestedExport !== undefined) {
    if (!(requestedExport in module)) {
      throw new TypeError(
        `file "${filePath}" does not export "${requestedExport}". Available exports: ${listExports(module)}`
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
    `file "${filePath}" must export either "default" or "main()". Available exports: ${listExports(module)}`
  )
}

async function resolveWorkflowFile(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath)
  let stats

  try {
    stats = await stat(resolvedPath)
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
      throw new Error(`workflow file not found: ${resolvedPath}`)
    }
    throw error
  }

  if (!stats.isFile()) {
    throw new Error(`workflow path is not a file: ${resolvedPath}`)
  }

  await access(resolvedPath, constants.R_OK)
  return resolvedPath
}

/** Loads, resolves, and evaluates one workflow while preserving the stdout/stderr boundary. */
export async function executeWorkflow(options: WorkflowRunOptions): Promise<WorkflowRunResult> {
  const resolvedPath = await resolveWorkflowFile(options.filePath)
  const runIdFallback = createHash("sha1").update(resolvedPath).digest("hex").slice(0, 8)
  const startedAt = performance.now()

  options.signal?.throwIfAborted()
  await applyWorkflowEnv(resolvedPath, options.envFilePath)
  options.signal?.throwIfAborted()

  const module = await loadWorkflowModule(resolvedPath)
  const selectedExport = resolveWorkflowExport(module, options.exportName, resolvedPath)
  const workflow = typeof selectedExport === "function" ? Reflect.apply(selectedExport, undefined, []) : selectedExport

  const runtime = new AmlRuntime()
  let runId: string | undefined
  const evaluationStartedAt = Date.now()

  runtime.on("start", event => {
    runId = event.runId
    options.writeDiagnostic(`aml: starting run ${event.runId} for ${resolvedPath}`)
  })
  runtime.on("finish", event => {
    options.writeDiagnostic(
      `aml: finished run ${runId ?? runIdFallback} (${event.status === "ok" ? "ok" : "error"}) in ${
        Date.now() - evaluationStartedAt
      }ms`
    )
  })

  if (options.enableTrace) {
    runtime.on(
      "trace",
      createConsoleTracer({
        captureContent: options.captureTraceContent,
        write: options.writeDiagnostic,
      })
    )
  }

  const result = await runtime.evaluate(workflow as AmlRenderable, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  return {
    durationMs: performance.now() - startedAt,
    result,
    runId: runId ?? runIdFallback,
  }
}
