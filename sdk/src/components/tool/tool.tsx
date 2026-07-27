import { AmlNode } from "../../core/aml-node.js"
import type { AmlTool } from "./agent-tool.js"

/**
 * Grants either one provider-owned Tool name or one defineTool() result.
 */
export type ToolProps =
  | {
      readonly name: string
      readonly use?: never
    }
  | {
      readonly name?: never
      readonly use: AmlTool
    }

/**
 * Grants one host or JavaScript capability to its containing Agent.
 */
export function Tool(_props: ToolProps): never {
  throw new Error("<Tool> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Tool, "tool")
