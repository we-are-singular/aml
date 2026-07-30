import type { SandboxSession } from "../sandbox/sandbox-provider.js"
import { EvaluationError } from "../../core/evaluation-error.js"
import { supportsSandboxRuntime } from "../sandbox/sandbox-runtime.js"
import type { ScriptProps, ScriptShell } from "./script.js"

interface CommandScriptEvaluation {
  readonly args: readonly string[]
  readonly command: string
  readonly kind: "command"
  readonly sandbox: Readonly<SandboxSession>
  readonly timeoutMs: number | undefined
}

interface InterpretedScriptEvaluation {
  readonly kind: "interpreted"
  readonly sandbox: Readonly<SandboxSession>
  readonly shell: ScriptShell
  readonly timeoutMs: number | undefined
}

export type ScriptEvaluation = CommandScriptEvaluation | InterpretedScriptEvaluation

/**
 * Validates and executes one explicitly sandboxed authored command.
 */
export class ScriptEvaluator {
  /**
   * Captures execution configuration before resolving dynamic Script children.
   */
  prepare(props: Readonly<ScriptProps>, sandbox: Readonly<SandboxSession> | undefined): Readonly<ScriptEvaluation> {
    if (sandbox === undefined) {
      throw new EvaluationError("<Script> requires an enclosing <Sandbox>")
    }

    if (!supportsSandboxRuntime(sandbox)) {
      throw new EvaluationError(
        `<Script> cannot execute because Sandbox provider "${sandbox.provider.name}" does not enforce the effective scope`
      )
    }

    const timeoutMs = validateTimeout(props.timeoutMs)
    const hasCommand = props.command !== undefined
    const hasShell = props.shell !== undefined

    if (hasCommand === hasShell) {
      throw new EvaluationError("<Script> requires exactly one of command or shell")
    }

    if (hasCommand) {
      if (props.children !== undefined) {
        throw new EvaluationError("<Script command> cannot have children")
      }

      if (typeof props.command !== "string" || props.command.length === 0 || props.command !== props.command.trim()) {
        throw new EvaluationError("<Script> command must be a non-empty normalized string")
      }

      const args = props.args ?? []

      if (!Array.isArray(args) || args.some(argument => typeof argument !== "string")) {
        throw new EvaluationError("<Script> args must contain only strings")
      }

      return Object.freeze({
        args: Object.freeze([...args]),
        command: props.command,
        kind: "command",
        sandbox,
        timeoutMs,
      })
    }

    if (props.args !== undefined) {
      throw new EvaluationError("<Script shell> does not accept args")
    }

    if (props.shell !== "sh" && props.shell !== "bash" && props.shell !== "node") {
      throw new EvaluationError('<Script> shell must be "sh", "bash", or "node"')
    }

    return Object.freeze({
      kind: "interpreted",
      sandbox,
      shell: props.shell,
      timeoutMs,
    })
  }

  /**
   * Runs the prepared command and returns standard output to AML's text flow.
   */
  async complete(
    plan: Readonly<ScriptEvaluation>,
    source: string,
    signal: AbortSignal
  ): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> {
    let command: string
    let args: readonly string[]

    if (plan.kind === "command") {
      command = plan.command
      args = plan.args
    } else {
      if (source.trim().length === 0) {
        throw new EvaluationError("<Script shell> must resolve to non-empty source")
      }

      command = plan.shell
      args = plan.shell === "node" ? ["--input-type=module", "--eval", source] : ["-c", source]
    }

    const result = await plan.sandbox.lease.runtime.exec(command, args, {
      signal,
      ...(plan.timeoutMs === undefined ? {} : { timeoutMs: plan.timeoutMs }),
    })

    if (result.exitCode !== 0) {
      const detail = result.stderr.trim()
      throw new EvaluationError(
        `<Script> exited with code ${result.exitCode}${detail.length === 0 ? "" : `: ${detail}`}`
      )
    }

    return result
  }
}

function validateTimeout(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new EvaluationError("<Script> timeoutMs must be a positive safe integer")
  }

  return value as number
}
