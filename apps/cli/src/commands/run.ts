import type { CAC } from "cac"

import type { CliIo } from "../cli.js"
import { executeWorkflow } from "../workflow-runner.js"

interface RunOptions {
  readonly captureContent?: boolean
  readonly entry?: string
  readonly json?: boolean
  readonly runtimeEnvFile?: string
  readonly trace?: boolean
}

async function runWorkflow(workflowFile: string, options: RunOptions, io: CliIo): Promise<number> {
  const outcome = await executeWorkflow({
    captureTraceContent: options.captureContent ?? false,
    enableTrace: (options.trace ?? false) || (options.captureContent ?? false),
    ...(options.entry === undefined ? {} : { exportName: options.entry }),
    ...(options.runtimeEnvFile === undefined ? {} : { envFilePath: options.runtimeEnvFile }),
    filePath: workflowFile,
    writeDiagnostic: line => io.stderr.write(`${line}\n`),
  })

  if (options.json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          runId: outcome.runId,
          durationMs: Math.round(outcome.durationMs * 10) / 10,
          success: true,
          result: outcome.result,
        },
        null,
        2
      )}\n`
    )
  } else {
    io.stdout.write(`${outcome.result}\n`)
  }

  return 0
}

/** Registers the provider-neutral workflow command and its process-level options. */
export function registerRunCommand(cli: CAC, io: CliIo): void {
  cli
    .command("run <workflowFile>", "Execute one trusted AML TypeScript, TSX, or JavaScript workflow")
    .option("-e, --entry <name>", "Export to execute; defaults to default, then main()")
    .option("--runtime-env-file <file>", "Apply an env file after workflow-local Vite env files")
    .option("--trace", "Write metadata-only AML trace events to stderr")
    .option("--capture-content", "Include sensitive prompt and result content in trace output")
    .option("--json", "Write the successful result as a JSON envelope")
    .example("aml run ./workflow.tsx")
    .example("aml run ./workflow.ts --entry releaseReview")
    .example("aml run ./workflow.tsx --trace")
    .action((workflowFile: string, options: RunOptions) => runWorkflow(workflowFile, options, io))
}
