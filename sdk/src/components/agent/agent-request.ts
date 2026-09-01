import type { AmlTraceIdentity } from "../../core/trace-identity.js"
import type { AgentMcpServer } from "../mcp/aml-mcp-server.js"
import type { AgentSkill } from "../skill/agent-skill.js"
import type { AgentTool } from "../tool/agent-tool.js"
import type { AgentOutputRequest } from "./agent-output-request.js"
import type { AgentPermissions } from "./agent.js"

/**
 * Provider-neutral input for one Agent session.
 */
export interface AgentRequest {
  /**
   * Ordered later user inputs executed in the same provider session.
   *
   * Omitted when the Agent has no `FollowUp` children. Each value is non-empty
   * trimmed text and shares the initial turn's capabilities and history.
   */
  readonly followUps?: readonly string[]

  /** Agent-local MCP grants in authored order; empty when none were declared. */
  readonly mcpServers: readonly AgentMcpServer[]

  /**
   * Provider-owned model identifier, or `undefined` to use the provider default.
   * AML does not normalize or validate provider-specific model names.
   */
  readonly model?: string

  /** Optional authored metadata used only for diagnostics and tracing. */
  readonly name?: string

  /** Portable structured-output request for the final turn, when configured. */
  readonly output?: AgentOutputRequest

  /** Fully defaulted native harness permission request for this session. */
  readonly permissions: AgentPermissions

  /** Trimmed initial user prompt; it may be empty when the Agent has no text. */
  readonly prompt: string

  /** Complete staged Agent Skill packages in authored order; empty when absent. */
  readonly skills: readonly AgentSkill[]

  /** Joined runtime, Agent, and child `System` text; empty when none exists. */
  readonly system: string

  /** Positive safe-integer Agent timeout in milliseconds, when configured. */
  readonly timeoutMs?: number

  /** Agent-local JavaScript Tool grants in authored order; empty when absent. */
  readonly tools: readonly AgentTool[]

  /**
   * Trace identity assigned by AML to the Agent request.
   *
   * Runtime-created requests include it. The property remains optional for
   * compatibility with independently authored provider requests.
   */
  readonly trace?: AmlTraceIdentity
}
