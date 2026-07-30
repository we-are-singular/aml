// Core agent authoring and provider-neutral execution contracts.
export { Agent, type AgentProps } from "./components/agent/agent.js"
export type { AgentExecutionContext } from "./components/agent/agent-execution-context.js"
export { AbstractAgentProvider } from "./components/agent/abstract-agent-provider.js"
export type { AmlModelSchema } from "./components/agent/aml-model-schema.js"
export type { AgentOutputRequest } from "./components/agent/agent-output-request.js"
export type { AgentProvider } from "./components/agent/agent-provider.js"
export type { AgentProviderSession, AgentProviderTurn } from "./components/agent/agent-provider-session.js"
export type { AgentRequest } from "./components/agent/agent-request.js"
export type { AgentResponse } from "./components/agent/agent-response.js"
export { createAgentProviderTurns } from "./components/agent/create-agent-provider-turns.js"
export { defineAgentProvider } from "./components/agent/define-agent-provider.js"
export { executeAgentProviderSession } from "./components/agent/execute-agent-provider-session.js"
export type {
  AmlEvaluationFinishEvent,
  AmlEvaluationStartEvent,
  AmlEventListener,
  AmlEventMap,
  AmlEventName,
  AmlEventSubscriber,
} from "./core/aml-event-subscriber.js"
export { FollowUp, type FollowUpProps } from "./components/follow-up/follow-up.js"
export { File, type FileProps } from "./components/file/file.js"
export { type DeepReadonly, Loop, type LoopProps, type LoopRenderContext } from "./components/loop/loop.js"
export { System, type SystemProps } from "./components/system/system.js"

// Immutable downward-scoped application dependencies.
export type { AmlContext, ContextProviderProps } from "./components/context/aml-context.js"
export { createContext } from "./components/context/create-context.js"
export { useContext } from "./components/context/use-context.js"

// Agent-scoped provider-native and explicitly configured MCP capabilities.
export type {
  AgentMcpServer,
  AmlMcpServer,
  AmlMcpStdioTransport,
  AmlMcpStreamableHttpTransport,
  AmlMcpTransport,
} from "./components/mcp/aml-mcp-server.js"
export {
  defineMcpServer,
  type DefineMcpServerOptions,
  type DefineMcpStdioTransport,
  type DefineMcpStreamableHttpTransport,
} from "./components/mcp/define-mcp-server.js"
export { Mcp, type McpProps } from "./components/mcp/mcp.js"

// Local and inline reusable instruction text.
export { Skill, type SkillProps } from "./components/skill/skill.js"

// Ephemeral execution scope and provider-neutral lease contracts.
export { AbstractSandboxProvider } from "./components/sandbox/abstract-sandbox-provider.js"
export { defineSandboxProvider } from "./components/sandbox/define-sandbox-provider.js"
export type { ProvisionedSandbox } from "./components/sandbox/provisioned-sandbox.js"
export { SandboxCommand } from "./components/sandbox/sandbox-command.js"
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
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxRuntime,
  supportsSandboxRuntime,
} from "./components/sandbox/sandbox-runtime.js"
export { Sandbox, type SandboxProps } from "./components/sandbox/sandbox.js"
export { Script, type ScriptProps, type ScriptShell } from "./components/script/script.js"

// Durable materialization scope and provider-neutral lifecycle contracts.
export { defineWorkspaceProvider } from "./components/workspace/define-workspace-provider.js"
export { WorkspaceConflictError } from "./components/workspace/workspace-conflict-error.js"
export {
  type WorkspaceAcquireRequest,
  type WorkspaceLoadRequest,
  type WorkspaceLease,
  type WorkspaceMaterializationReference,
  type WorkspaceProvider,
  type WorkspaceProviderReference,
  type WorkspaceSaveRequest,
} from "./components/workspace/workspace-provider.js"
export {
  Workspace,
  type WorkspaceLoadOptions,
  type WorkspaceProps,
  type WorkspaceSaveOptions,
} from "./components/workspace/workspace.js"
export {
  createPersistentWorkspaceProvider,
  type PersistentWorkspaceHandle,
  WorkspacePersistence,
  type WorkspacePersistenceOptions,
} from "./workspace-persistence/workspace-persistence.js"
export {
  type WorkspaceIndex,
  type WorkspacePersistenceFormat,
  type WorkspaceRevision,
} from "./workspace-persistence/workspace-index.js"
export {
  workspaceStorageSegment,
  type WorkspaceStorageAcquireRequest,
  type WorkspaceStorageAdapter,
  type WorkspaceStorageBody,
  type WorkspaceStorageEntry,
  type WorkspaceStorageLease,
  type WorkspaceStorageObject,
  type WorkspaceStorageVersion,
  type WorkspaceStorageWriteCondition,
  type WorkspaceStorageWriteOptions,
} from "./workspace-persistence/workspace-storage-adapter.js"

// Scoped provider-native and application-owned capabilities.
export type {
  AgentHostTool,
  AgentJavaScriptTool,
  AgentTool,
  AgentToolExecutionContext,
  AmlTool,
  AmlToolSchema,
} from "./components/tool/agent-tool.js"
export { defineTool, type DefineToolOptions } from "./components/tool/define-tool.js"
export { Tool, type ToolProps } from "./components/tool/tool.js"
export { ToolInputError } from "./components/tool/tool-input-error.js"
export { ToolOutputError } from "./components/tool/tool-output-error.js"

// Evaluator, JSX value, and trace contracts.
export type { AmlJsonValue } from "./core/aml-json-value.js"
export type { AmlRenderable } from "./core/aml-node.js"
export { AmlRuntime, type AmlEvaluationOptions, type AmlRuntimeOptions } from "./core/aml-runtime.js"
export { EvaluationError } from "./core/evaluation-error.js"
export { evaluate } from "./core/evaluate.js"
export type { AmlTraceIdentity } from "./core/trace-identity.js"

// Provider-neutral observability contracts and the dependency-free console view.
export { createConsoleTracer, type ConsoleTracerOptions } from "./observability/create-console-tracer.js"
export type {
  AmlTraceAttribute,
  AmlTraceEvent,
  AmlTraceEventBase,
  AmlTraceEventName,
  AmlTracePointEvent,
  AmlTraceSpanEndEvent,
  AmlTraceSpanKind,
  AmlTraceSpanStartEvent,
} from "./observability/trace-event.js"
export type { TraceErrorHandler, TraceSink } from "./observability/trace-sink.js"
export { Fragment } from "./jsx-runtime.js"
