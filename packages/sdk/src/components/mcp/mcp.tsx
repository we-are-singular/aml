import { AmlNode } from "../../core/aml-node.js"
import type { AmlMcpServer } from "./aml-mcp-server.js"

/**
 * Grants one provider-native name or one explicit MCP server definition.
 */
export type McpProps =
  | {
      readonly name: string
      readonly use?: never
    }
  | {
      readonly name?: never
      readonly use: AmlMcpServer
    }

/**
 * Declares one MCP capability for its nearest containing Agent.
 */
export function Mcp(_props: McpProps): never {
  throw new Error("<Mcp> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Mcp, "mcp")
