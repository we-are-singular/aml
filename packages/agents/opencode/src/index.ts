// Configured provider factory and lifecycle contract.
export {
  opencodeAgent,
  type OpenCodeAgentOptions,
  type OpenCodeAgentProvider,
  type OpenCodeServerOptions,
} from "./opencode-agent.js"

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
