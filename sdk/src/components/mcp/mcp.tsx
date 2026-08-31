import { AmlNode } from "../../core/aml-node.js"
import type { AmlMcpServer } from "./aml-mcp-server.js"

/**
 * Grants one provider-native name or one explicit MCP server definition.
 */
export type McpProps =
  | {
      /**
       * Non-empty normalized name of a provider-native MCP server.
       *
       * The selected Agent provider must recognize and expose this name. Names
       * must be unique within one Agent and may be restricted by the runtime's
       * `allowedMcpServers` allowlist.
       */
      readonly name: string

      /** Must be omitted when selecting a provider-native server by `name`. */
      readonly use?: never
    }
  | {
      /** Must be omitted when attaching an explicit server through `use`. */
      readonly name?: never

      /**
       * Exact stdio or Streamable HTTP definition returned by `defineMcpServer`.
       *
       * The Agent provider owns connection and session lifecycle. Transport
       * support and the location of stdio execution are provider-specific.
       */
      readonly use: AmlMcpServer
    }

/**
 * Grants one MCP capability to its nearest containing Agent.
 *
 * Choose exactly one of a provider-native `name` or an explicit `use`
 * definition. The grant is Agent-local, accepts no children, and does not
 * itself connect to or run the server.
 */
export function Mcp(_props: McpProps): never {
  throw new Error("<Mcp> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Mcp, "mcp")
