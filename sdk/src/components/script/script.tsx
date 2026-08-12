import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"

export type ScriptShell = "bash" | "node" | "sh"

/**
 * Authored execution using either a literal command or interpreter.
 */
export interface ScriptProps {
  readonly args?: readonly string[]
  readonly children?: AmlRenderable
  readonly command?: string
  readonly shell?: ScriptShell
  readonly timeoutMs?: number
}

/**
 * Executes resolved AML text or one literal command on the host or in the active Sandbox.
 */
export function Script(_props: ScriptProps): never {
  throw new Error("<Script> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Script, "script")
