import { AmlNode } from "../../core/aml-node.js"
import type { AmlTool } from "./agent-tool.js"

/** Grants one JavaScript Tool created by defineTool(). */
export interface ToolProps {
  readonly use: AmlTool<never, unknown>
}

/**
 * Grants one application-defined JavaScript capability to its containing Agent.
 */
export function Tool(_props: ToolProps): never {
  throw new Error("<Tool> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Tool, "tool")
