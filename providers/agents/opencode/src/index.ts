// Configured provider factory and lifecycle contract.
export { opencodeAgent, type OpenCodeAgentProvider } from "./opencode-agent.js"
export type { OpenCodeAgentOptions, OpenCodeServerOptions } from "./opencode-agent-options.js"

// Narrow session port exposed for deterministic tests and custom hosts.
export type {
  OpenCodeModel,
  OpenCodeSessionClient,
  OpenCodeSessionCreateInput,
  OpenCodeSessionLocation,
  OpenCodeSessionPart,
  OpenCodeSessionPromptInput,
  OpenCodeSessionPromptResult,
  OpenCodeCapabilityAttachment,
  OpenCodeCapabilityAttachmentInput,
} from "./opencode-session-client.js"
