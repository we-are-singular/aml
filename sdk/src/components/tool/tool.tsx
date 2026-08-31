import { AmlNode } from "../../core/aml-node.js"
import type { AmlTool } from "./agent-tool.js"

/** Grants one JavaScript Tool created by defineTool(). */
export interface ToolProps {
  /**
   * Exact callable Tool identity returned by `defineTool`.
   *
   * Structurally similar functions or objects are rejected. The Tool name must
   * be unique in the containing Agent and may be restricted by the runtime's
   * `allowedTools` allowlist.
   */
  readonly use: AmlTool<never, unknown>
}

/**
 * Grants one application-defined JavaScript capability to its containing Agent.
 *
 * The callback executes in the AML application process, not in an active
 * Sandbox. AML validates model input, snapshots JSON-compatible output, passes
 * cancellation and trace context, and keeps the grant local to this Agent.
 */
export function Tool(_props: ToolProps): never {
  throw new Error("<Tool> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Tool, "tool")
