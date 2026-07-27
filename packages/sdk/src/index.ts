// Agent authoring and provider-neutral execution contracts.
export { Agent, type AgentProps } from "./components/agent/agent.js"
export type { AgentExecutionContext } from "./components/agent/agent-execution-context.js"
export type { AgentProvider } from "./components/agent/agent-provider.js"
export type { AgentRequest } from "./components/agent/agent-request.js"
export type { AgentResponse } from "./components/agent/agent-response.js"
export { defineAgentProvider } from "./components/agent/define-agent-provider.js"
export { System, type SystemProps } from "./components/system/system.js"

// Local and inline reusable instruction text.
export { Skill, type SkillProps } from "./components/skill/skill.js"

// Ephemeral execution scope and provider-neutral lease contracts.
export { defineSandboxProvider } from "./components/sandbox/define-sandbox-provider.js"
export {
  type SandboxAccess,
  type SandboxAcquireRequest,
  type SandboxLease,
  type SandboxLeaseReference,
  type SandboxProvider,
  type SandboxProviderReference,
  type SandboxSession,
} from "./components/sandbox/sandbox-provider.js"
export {
  Sandbox,
  type SandboxProps,
} from "./components/sandbox/sandbox.js"

// Scoped provider-native and application-owned capabilities.
export type {
  AgentHostTool,
  AgentJavaScriptTool,
  AgentTool,
  AgentToolExecutionContext,
  AmlJsonValue,
  AmlTool,
  AmlToolSchema,
} from "./components/tool/agent-tool.js"
export {
  defineTool,
  type DefineToolOptions,
} from "./components/tool/define-tool.js"
export { Tool, type ToolProps } from "./components/tool/tool.js"
export { ToolInputError } from "./components/tool/tool-input-error.js"
export { ToolOutputError } from "./components/tool/tool-output-error.js"

// Evaluator, JSX value, and trace contracts.
export type { AmlRenderable } from "./core/aml-node.js"
export {
  AmlRuntime,
  type AmlEvaluationOptions,
  type AmlRuntimeOptions,
} from "./core/aml-runtime.js"
export { EvaluationError } from "./core/evaluation-error.js"
export type { AmlTraceIdentity } from "./core/trace-identity.js"
export { Fragment } from "./jsx-runtime.js"
