import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"

/**
 * Explicit interpreter available to the source form of `Script`.
 *
 * `"sh"` and `"bash"` receive source through `-c`; `"node"` evaluates it as an
 * ES module. AML does not choose an interpreter implicitly.
 */
export type ScriptShell = "bash" | "node" | "sh"

/**
 * Options shared by both Script execution forms.
 */
interface SharedScriptProps {
  /**
   * Portable relative working directory for the process.
   *
   * On the host it resolves from `AmlRuntimeOptions.cwd`; in a Sandbox it
   * resolves from the effective Sandbox root. Omission uses the active cwd.
   */
  readonly cwd?: string

  /**
   * Positive safe-integer execution limit in milliseconds.
   *
   * Omission applies no Script-local timeout. Evaluation cancellation remains
   * active in both host and Sandbox execution.
   */
  readonly timeoutMs?: number
}

/**
 * Authored execution using either a literal command or explicit interpreter.
 */
export type ScriptProps =
  | (SharedScriptProps & {
      /**
       * Literal arguments passed directly to `command` without shell joining.
       *
       * Defaults to an empty array.
       */
      readonly args?: readonly string[]

      /** Must be omitted in literal-command form. */
      readonly children?: never

      /**
       * Non-empty normalized executable name or path invoked directly.
       *
       * AML does not parse shell syntax or interpolate `args` into this value.
       */
      readonly command: string

      /** Must be omitted in literal-command form. */
      readonly shell?: never
    })
  | (SharedScriptProps & {
      /** Must be omitted in interpreted-source form. */
      readonly args?: never

      /**
       * AML content resolved to non-empty source for the selected `shell`.
       *
       * Nested Agents or components finish before the source process starts.
       */
      readonly children: AmlRenderable

      /** Must be omitted in interpreted-source form. */
      readonly command?: never

      /** Explicit interpreter used to execute the resolved child source. */
      readonly shell: ScriptShell
    })

/**
 * Executes resolved AML text or one literal command on the host or in the active Sandbox.
 *
 * Outside a Sandbox this is trusted, unconfined host execution. Inside a
 * Sandbox the active provider runtime is mandatory and AML never falls back to
 * the host. Successful stdout becomes AML text; a non-zero exit rejects with
 * stderr detail when available.
 */
export function Script(_props: ScriptProps): never {
  throw new Error("<Script> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Script, "script")
