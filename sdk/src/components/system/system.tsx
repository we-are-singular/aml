import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"

/**
 * Children whose resolved text becomes part of the nearest Agent system prompt.
 */
export interface SystemProps {
  /**
   * AML content resolved into system text for the nearest containing Agent.
   *
   * Omission contributes no fragment. Multiple `System` components preserve
   * authored order after runtime-wide and Agent-level fixed system text.
   */
  readonly children?: AmlRenderable
}

/**
 * Routes resolved child text into the nearest Agent system prompt.
 *
 * The component opens no session and changes only the message channel; provider,
 * Sandbox, Tool, and MCP scope continue to belong to the containing Agent.
 */
export function System(_props: SystemProps): never {
  throw new Error("<System> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(System, "system")
