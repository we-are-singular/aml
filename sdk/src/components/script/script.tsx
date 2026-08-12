import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"

export type ScriptShell = "bash" | "node" | "sh"

/**
 * Options shared by both Script execution forms.
 */
interface SharedScriptProps {
  readonly cwd?: string
  readonly timeoutMs?: number
}

/**
 * Authored execution using either a literal command or explicit interpreter.
 */
export type ScriptProps =
  | (SharedScriptProps & {
      readonly args?: readonly string[]
      readonly children?: never
      readonly command: string
      readonly shell?: never
    })
  | (SharedScriptProps & {
      readonly args?: never
      readonly children: AmlRenderable
      readonly command?: never
      readonly shell: ScriptShell
    })

/**
 * Executes resolved AML text or one literal command on the host or in the active Sandbox.
 */
export function Script(_props: ScriptProps): never {
  throw new Error("<Script> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Script, "script")
