/** OpenCode log levels ordered from most to least verbose. */
type OpenCodeLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"

/** Listener settings used by OpenCode's `serve` and `web` commands. */
interface OpenCodeServerConfig {
  /** TCP port on which the OpenCode server listens. */
  port?: number

  /** Hostname or IP address to which the server binds. */
  hostname?: string

  /** Whether to advertise the server over multicast DNS. */
  mdns?: boolean

  /** Custom multicast-DNS domain advertised for the server. */
  mdnsDomain?: string

  /** Browser origins allowed to make cross-origin requests to the server. */
  cors?: string[]
}

/** One named OpenCode command and the prompt it expands to. */
interface OpenCodeCommandDefinition {
  /** Prompt template rendered when the command is invoked. */
  template: string

  /** Human-readable command description shown by OpenCode. */
  description?: string

  /** Agent profile selected when the command runs. */
  agent?: string

  /** Provider/model identifier selected for the command. */
  model?: string

  /** Model variant selected for the command. */
  variant?: string

  /** Whether the command runs as a delegated subtask. */
  subtask?: boolean
}

/** Named command definitions keyed by the command users invoke. */
interface OpenCodeCommandConfig {
  /** Defines one command under its OpenCode command name. */
  [name: string]: OpenCodeCommandDefinition
}

/** Additional locations from which OpenCode discovers Agent Skills. */
interface OpenCodeSkillsConfig {
  /** Filesystem paths searched for skills. */
  paths?: string[]

  /** Remote URLs from which skills are loaded. */
  urls?: string[]
}

/** Git-backed reference content available to OpenCode. */
interface OpenCodeGitReferenceConfig {
  /** Git repository URL or repository identifier. */
  repository: string

  /** Branch selected from the repository; omitted to use its default branch. */
  branch?: string

  /** Human-readable explanation of the reference. */
  description?: string

  /** Whether OpenCode hides the reference from normal discovery. */
  hidden?: boolean
}

/** Filesystem-backed reference content available to OpenCode. */
interface OpenCodeLocalReferenceConfig {
  /** Local path containing the reference content. */
  path: string

  /** Human-readable explanation of the reference. */
  description?: string

  /** Whether OpenCode hides the reference from normal discovery. */
  hidden?: boolean
}

/** A direct reference string, Git source, or local filesystem source. */
type OpenCodeReferenceConfig = string | OpenCodeGitReferenceConfig | OpenCodeLocalReferenceConfig

/** Named OpenCode references keyed by the name exposed to Agents. */
interface OpenCodeReferencesConfig {
  /** Defines one reference under its OpenCode-visible name. */
  [name: string]: OpenCodeReferenceConfig
}

/** File-watcher behavior for the OpenCode project. */
interface OpenCodeWatcherConfig {
  /** Path patterns excluded from filesystem watching. */
  ignore?: string[]
}

/** Provider-native settings passed to an OpenCode plugin. */
interface OpenCodePluginOptions {
  /** Supplies one plugin-defined JSON-compatible option. */
  [name: string]: unknown
}

/** Plugin package name, optionally paired with its native options. */
type OpenCodePluginConfig = string | [name: string, options: OpenCodePluginOptions]

/** Decision OpenCode applies when a permission rule matches. */
type OpenCodePermissionAction = "ask" | "allow" | "deny"

/** Resource-pattern decisions for one OpenCode permission category. */
interface OpenCodePermissionObjectConfig {
  /** Applies a permission action to one resource pattern. */
  [resource: string]: OpenCodePermissionAction
}

/** A category-wide permission action or resource-specific permission table. */
type OpenCodePermissionRuleConfig = OpenCodePermissionAction | OpenCodePermissionObjectConfig

/** Per-capability native permission policy understood by OpenCode. */
interface OpenCodePermissionRulesConfig {
  /** Permission applied when Agents read files. */
  read?: OpenCodePermissionRuleConfig

  /** Permission applied when Agents edit files. */
  edit?: OpenCodePermissionRuleConfig

  /** Permission applied to filesystem glob searches. */
  glob?: OpenCodePermissionRuleConfig

  /** Permission applied to text searches. */
  grep?: OpenCodePermissionRuleConfig

  /** Permission applied to directory listings. */
  list?: OpenCodePermissionRuleConfig

  /** Permission applied to shell commands. */
  bash?: OpenCodePermissionRuleConfig

  /** Permission applied when spawning native subagents. */
  task?: OpenCodePermissionRuleConfig

  /** Permission applied when accessing paths outside the project directory. */
  external_directory?: OpenCodePermissionRuleConfig

  /** Permission applied when an Agent updates its todo list. */
  todowrite?: OpenCodePermissionAction

  /** Permission applied when an Agent asks the user a question. */
  question?: OpenCodePermissionAction

  /** Permission applied to fetching a known web address. */
  webfetch?: OpenCodePermissionAction

  /** Permission applied to web searches. */
  websearch?: OpenCodePermissionAction

  /** Permission applied to language-server operations. */
  lsp?: OpenCodePermissionRuleConfig

  /** Permission applied when OpenCode detects a repeated tool-call loop. */
  doom_loop?: OpenCodePermissionAction

  /** Permission applied when loading a skill. */
  skill?: OpenCodePermissionRuleConfig

  /** Defines a native or plugin permission category not listed above. */
  [permission: string]: OpenCodePermissionRuleConfig | OpenCodePermissionAction | undefined
}

/** Global permission action or per-capability native OpenCode policy. */
type OpenCodePermissionConfig = OpenCodePermissionAction | OpenCodePermissionRulesConfig

/** Native tool enablement keyed by OpenCode tool name or pattern. */
interface OpenCodeToolConfig {
  /** Enables or disables matching native tools. */
  [tool: string]: boolean
}

/** Provider-native options passed to one OpenCode Agent profile. */
interface OpenCodeAgentOptionsConfig {
  /** Supplies one OpenCode or model-provider-specific Agent option. */
  [name: string]: unknown
}

/** Configuration for one native OpenCode Agent profile. */
interface OpenCodeAgentConfig {
  /** Provider/model identifier used by the Agent. */
  model?: string

  /** Named variant selected for the model. */
  variant?: string

  /** Sampling temperature passed to models that support it. */
  temperature?: number

  /** Nucleus-sampling threshold passed to models that support it. */
  top_p?: number

  /** Additional system prompt supplied to the Agent. */
  prompt?: string

  /** Native tool enablement overrides for this Agent. */
  tools?: OpenCodeToolConfig

  /** Whether OpenCode excludes this Agent from use. */
  disable?: boolean

  /** Human-readable role description used for Agent discovery. */
  description?: string

  /** Whether the Agent is primary, delegated, or available in both roles. */
  mode?: "subagent" | "primary" | "all"

  /** Whether OpenCode hides the Agent from normal selection interfaces. */
  hidden?: boolean

  /** Provider-native request and model options for this Agent. */
  options?: OpenCodeAgentOptionsConfig

  /** Hex or theme color used to display the Agent. */
  color?: string

  /** Maximum number of execution steps allowed for this Agent. */
  steps?: number

  /** Legacy alias for the Agent execution-step limit. */
  maxSteps?: number

  /** Native permission policy applied to this Agent. */
  permission?: OpenCodePermissionConfig

  /** Preserves OpenCode or plugin Agent properties introduced by the bundled SDK. */
  [name: string]: unknown
}

/** Legacy build, plan, and custom OpenCode mode definitions. */
interface OpenCodeModeConfig {
  /** Native build-mode Agent profile. */
  build?: OpenCodeAgentConfig

  /** Native plan-mode Agent profile. */
  plan?: OpenCodeAgentConfig

  /** Defines an additional mode under its native OpenCode name. */
  [name: string]: OpenCodeAgentConfig | undefined
}

/** Named native Agent profiles recognized by OpenCode. */
interface OpenCodeAgentProfilesConfig {
  /** Native plan Agent profile. */
  plan?: OpenCodeAgentConfig

  /** Native build Agent profile. */
  build?: OpenCodeAgentConfig

  /** General-purpose delegated Agent profile. */
  general?: OpenCodeAgentConfig

  /** Repository-exploration Agent profile. */
  explore?: OpenCodeAgentConfig

  /** Agent profile used to generate session titles. */
  title?: OpenCodeAgentConfig

  /** Agent profile used to generate summaries. */
  summary?: OpenCodeAgentConfig

  /** Agent profile used during context compaction. */
  compaction?: OpenCodeAgentConfig

  /** Defines another Agent under its native OpenCode name. */
  [name: string]: OpenCodeAgentConfig | undefined
}

/** Provider-specific connection and request options. */
interface OpenCodeProviderOptionsConfig {
  /** API credential passed to the provider. */
  apiKey?: string

  /** Base API URL used instead of the provider's default endpoint. */
  baseURL?: string

  /** Enterprise service URL used by providers that distinguish it. */
  enterpriseUrl?: string

  /** Whether the provider sets a stable cache key for supported requests. */
  setCacheKey?: boolean

  /** Full-request timeout in milliseconds, or `false` to disable it. */
  timeout?: number | false

  /** Response-header timeout in milliseconds, or `false` to disable it. */
  headerTimeout?: number | false

  /** Maximum delay in milliseconds between streamed response chunks. */
  chunkTimeout?: number

  /** Supplies another provider-native option. */
  [name: string]: unknown
}

/** Field used by providers that return reasoning in an interleaved response. */
interface OpenCodeModelInterleavingConfig {
  /** Response field containing the interleaved reasoning payload. */
  field: "reasoning" | "reasoning_content" | "reasoning_details"
}

/** Provider-reported pricing for one model usage tier. */
interface OpenCodeModelTierCostConfig {
  /** Price assigned to input tokens. */
  input: number

  /** Price assigned to output tokens. */
  output: number

  /** Optional price assigned to cached input reads. */
  cache_read?: number

  /** Optional price assigned to cached input writes. */
  cache_write?: number
}

/** Provider-reported pricing used by OpenCode for a model. */
interface OpenCodeModelCostConfig extends OpenCodeModelTierCostConfig {
  /** Alternate pricing applied when context exceeds 200,000 tokens. */
  context_over_200k?: OpenCodeModelTierCostConfig
}

/** Token limits advertised for one configured model. */
interface OpenCodeModelLimitConfig {
  /** Maximum context-window size in tokens. */
  context: number

  /** Optional maximum input size in tokens. */
  input?: number

  /** Maximum output size in tokens. */
  output: number
}

/** Content kinds accepted or produced by a configured model. */
type OpenCodeModelModality = "text" | "audio" | "image" | "video" | "pdf"

/** Input and output modalities advertised for one model. */
interface OpenCodeModelModalitiesConfig {
  /** Content kinds the model accepts as input. */
  input?: OpenCodeModelModality[]

  /** Content kinds the model may emit as output. */
  output?: OpenCodeModelModality[]
}

/** Model-specific provider adapter override. */
interface OpenCodeModelProviderConfig {
  /** npm package implementing the model adapter. */
  npm?: string

  /** API identifier used by the adapter. */
  api?: string
}

/** Provider-native options passed only to one configured model. */
interface OpenCodeModelOptionsConfig {
  /** Supplies one model-provider-specific option. */
  [name: string]: unknown
}

/** HTTP headers added to requests for one configured model. */
interface OpenCodeModelHeadersConfig {
  /** Supplies one request header value. */
  [name: string]: string
}

/** Provider-native options for one named model variant. */
interface OpenCodeModelVariantConfig {
  /** Whether the variant is unavailable for selection. */
  disabled?: boolean

  /** Supplies another model-variant option. */
  [name: string]: unknown
}

/** Named model variants exposed by OpenCode. */
interface OpenCodeModelVariantsConfig {
  /** Defines one variant under its selectable name. */
  [name: string]: OpenCodeModelVariantConfig
}

/** One model added to or overridden within an OpenCode provider. */
interface OpenCodeProviderModelConfig {
  /** Provider-native model identifier. */
  id?: string

  /** Human-readable model name displayed by OpenCode. */
  name?: string

  /** Model family used for grouping and compatibility behavior. */
  family?: string

  /** Model release date understood by OpenCode. */
  release_date?: string

  /** Whether the model accepts file or image attachments. */
  attachment?: boolean

  /** Whether the model supports reasoning output. */
  reasoning?: boolean

  /** Whether callers may configure sampling temperature. */
  temperature?: boolean

  /** Whether the model supports tool calls. */
  tool_call?: boolean

  /** Whether and where reasoning is interleaved with normal output. */
  interleaved?: true | OpenCodeModelInterleavingConfig

  /** Provider-reported usage pricing. */
  cost?: OpenCodeModelCostConfig

  /** Context, input, and output token limits. */
  limit?: OpenCodeModelLimitConfig

  /** Content kinds accepted and emitted by the model. */
  modalities?: OpenCodeModelModalitiesConfig

  /** Whether OpenCode treats the model definition as experimental. */
  experimental?: boolean

  /** Model lifecycle status displayed by OpenCode. */
  status?: "alpha" | "beta" | "deprecated" | "active"

  /** Adapter package or API override for this model. */
  provider?: OpenCodeModelProviderConfig

  /** Provider-native options passed to this model. */
  options?: OpenCodeModelOptionsConfig

  /** HTTP headers added to this model's requests. */
  headers?: OpenCodeModelHeadersConfig

  /** Named provider-native variants of this model. */
  variants?: OpenCodeModelVariantsConfig
}

/** Named model definitions owned by one provider. */
interface OpenCodeProviderModelsConfig {
  /** Defines one model under its OpenCode-visible identifier. */
  [model: string]: OpenCodeProviderModelConfig
}

/** Native configuration for one OpenCode model provider. */
interface OpenCodeProviderConfig {
  /** API identifier used by the provider adapter. */
  api?: string

  /** Human-readable provider name. */
  name?: string

  /** Environment-variable names from which credentials may be discovered. */
  env?: string[]

  /** Native provider identifier. */
  id?: string

  /** npm package implementing the provider adapter. */
  npm?: string

  /** Model identifiers explicitly allowed from this provider. */
  whitelist?: string[]

  /** Model identifiers excluded from this provider. */
  blacklist?: string[]

  /** Provider connection, credential, and request options. */
  options?: OpenCodeProviderOptionsConfig

  /** Models added to or overridden for this provider. */
  models?: OpenCodeProviderModelsConfig
}

/** Named OpenCode providers keyed by provider identifier. */
interface OpenCodeProvidersConfig {
  /** Configures one provider under its OpenCode identifier. */
  [provider: string]: OpenCodeProviderConfig
}

/** Environment variables supplied to a local MCP server process. */
interface OpenCodeMcpEnvironmentConfig {
  /** Supplies one environment variable. */
  [name: string]: string
}

/** Native local-process MCP server configuration. */
interface OpenCodeLocalMcpConfig {
  /** Selects local process transport. */
  type: "local"

  /** Executable followed by arguments used to launch the MCP server. */
  command: string[]

  /** Working directory from which the MCP process starts. */
  cwd?: string

  /** Environment variables supplied to the MCP process. */
  environment?: OpenCodeMcpEnvironmentConfig

  /** Whether OpenCode starts and exposes this server. */
  enabled?: boolean

  /** MCP connection timeout in milliseconds. */
  timeout?: number
}

/** OAuth client settings for a remote MCP server. */
interface OpenCodeMcpOAuthConfig {
  /** OAuth client identifier. */
  clientId?: string

  /** OAuth client secret. */
  clientSecret?: string

  /** Space-delimited OAuth scopes requested from the server. */
  scope?: string

  /** Local callback port used during OAuth authorization. */
  callbackPort?: number

  /** Explicit OAuth redirect URI. */
  redirectUri?: string
}

/** HTTP headers supplied to a remote MCP server. */
interface OpenCodeMcpHeadersConfig {
  /** Supplies one remote MCP request header. */
  [name: string]: string
}

/** Native remote HTTP MCP server configuration. */
interface OpenCodeRemoteMcpConfig {
  /** Selects remote transport. */
  type: "remote"

  /** URL of the remote MCP endpoint. */
  url: string

  /** Whether OpenCode connects to and exposes this server. */
  enabled?: boolean

  /** HTTP headers supplied to the remote MCP endpoint. */
  headers?: OpenCodeMcpHeadersConfig

  /** OAuth settings, or `false` to disable OAuth auto-detection. */
  oauth?: OpenCodeMcpOAuthConfig | false

  /** MCP request timeout in milliseconds. */
  timeout?: number
}

/** Minimal override that only toggles an otherwise discovered MCP server. */
interface OpenCodeEnabledMcpConfig {
  /** Whether OpenCode exposes the discovered server. */
  enabled: boolean
}

/** Named native MCP servers keyed by the name exposed to OpenCode Agents. */
interface OpenCodeMcpConfig {
  /** Defines or toggles one native MCP server. */
  [name: string]: OpenCodeLocalMcpConfig | OpenCodeRemoteMcpConfig | OpenCodeEnabledMcpConfig
}

/** Environment variables supplied to one formatter process. */
interface OpenCodeFormatterEnvironmentConfig {
  /** Supplies one formatter environment variable. */
  [name: string]: string
}

/** Override for one built-in or custom formatter. */
interface OpenCodeFormatterConfig {
  /** Whether OpenCode disables this formatter. */
  disabled?: boolean

  /** Executable followed by arguments used to format a file. */
  command?: string[]

  /** Environment variables supplied to the formatter process. */
  environment?: OpenCodeFormatterEnvironmentConfig

  /** File extensions handled by the formatter. */
  extensions?: string[]
}

/** Formatter overrides keyed by built-in or custom formatter name. */
interface OpenCodeFormattersConfig {
  /** Configures one formatter. */
  [name: string]: OpenCodeFormatterConfig
}

/** Configuration that explicitly disables one language server. */
interface OpenCodeDisabledLspConfig {
  /** Required disable marker for this language-server entry. */
  disabled: true
}

/** Environment variables supplied to one language-server process. */
interface OpenCodeLspEnvironmentConfig {
  /** Supplies one language-server environment variable. */
  [name: string]: string
}

/** JSON-compatible initialization options passed to a language server. */
interface OpenCodeLspInitializationConfig {
  /** Supplies one server-specific initialization option. */
  [name: string]: unknown
}

/** Launch configuration for a built-in or custom language server. */
interface OpenCodeLspLaunchConfig {
  /** Executable followed by arguments used to launch the language server. */
  command: string[]

  /** File extensions handled by the language server. */
  extensions?: string[]

  /** Whether OpenCode disables this language server. */
  disabled?: boolean

  /** Environment variables supplied to the language-server process. */
  env?: OpenCodeLspEnvironmentConfig

  /** Server-specific initialization options sent during LSP startup. */
  initialization?: OpenCodeLspInitializationConfig
}

/** Language-server overrides keyed by built-in or custom server name. */
interface OpenCodeLanguageServersConfig {
  /** Disables or configures one language server. */
  [name: string]: OpenCodeDisabledLspConfig | OpenCodeLspLaunchConfig
}

/** Image normalization and size limits for OpenCode attachments. */
interface OpenCodeImageAttachmentConfig {
  /** Whether OpenCode automatically resizes oversized images. */
  auto_resize?: boolean

  /** Maximum image width in pixels. */
  max_width?: number

  /** Maximum image height in pixels. */
  max_height?: number

  /** Maximum encoded image payload size in bytes. */
  max_base64_bytes?: number
}

/** Attachment handling behavior used by OpenCode. */
interface OpenCodeAttachmentConfig {
  /** Image resizing and payload limits. */
  image?: OpenCodeImageAttachmentConfig
}

/** Enterprise service connection used by OpenCode. */
interface OpenCodeEnterpriseConfig {
  /** Base URL of the enterprise OpenCode service. */
  url?: string
}

/** Retention limits applied to native tool output. */
interface OpenCodeToolOutputConfig {
  /** Maximum number of output lines retained. */
  max_lines?: number

  /** Maximum number of output bytes retained. */
  max_bytes?: number
}

/** Automatic context compaction and pruning behavior. */
interface OpenCodeCompactionConfig {
  /** Whether OpenCode compacts automatically near the context limit. */
  auto?: boolean

  /** Whether OpenCode removes old tool output during compaction. */
  prune?: boolean

  /** Number of recent conversation turns retained during compaction. */
  tail_turns?: number

  /** Number of recent tokens retained during compaction. */
  preserve_recent_tokens?: number

  /** Token capacity reserved for compaction output and subsequent work. */
  reserved?: number
}

/** Allow-or-deny rule for one experimental OpenCode resource policy. */
interface OpenCodeExperimentalPolicyConfig {
  /** Policy action; the bundled SDK currently supports provider use. */
  action: "provider.use"

  /** Whether matching access is permitted. */
  effect: "allow" | "deny"

  /** Resource selector to which the policy applies. */
  resource: string
}

/** Unstable settings whose behavior may change between OpenCode versions. */
interface OpenCodeExperimentalConfig {
  /** Whether OpenCode suppresses summaries for large pasted content. */
  disable_paste_summary?: boolean

  /** Whether OpenCode enables its experimental batched-tool behavior. */
  batch_tool?: boolean

  /** Whether OpenCode emits OpenTelemetry data. */
  openTelemetry?: boolean

  /** Native tools promoted for primary-Agent use. */
  primary_tools?: string[]

  /** Whether an Agent loop continues after a denied permission request. */
  continue_loop_on_deny?: boolean

  /** Experimental default MCP timeout in milliseconds. */
  mcp_timeout?: number

  /** Experimental resource policies evaluated by OpenCode. */
  policies?: OpenCodeExperimentalPolicyConfig[]
}

/**
 * Native OpenCode configuration accepted by {@link opencodeAgent}.
 *
 * Every top-level property is optional. Optional nested properties remain
 * absent unless authored, leaving the bundled OpenCode version to apply its
 * native behavior. AML requires a finite, acyclic JSON graph, captures it before
 * process acquisition, then overlays the effective AML model, Agent profile,
 * tools, and permission denials.
 */
export interface OpenCodeConfig {
  /** JSON Schema URL used by editors to validate a serialized config file. */
  $schema?: string

  /** Shell command selected by OpenCode for native shell execution. */
  shell?: string

  /** Minimum OpenCode log level; omitted to use OpenCode's default. */
  logLevel?: OpenCodeLogLevel

  /** Server and listener settings for OpenCode's serve and web commands. */
  server?: OpenCodeServerConfig

  /** Named custom commands and their prompt templates. */
  command?: OpenCodeCommandConfig

  /** Additional filesystem paths or URLs from which OpenCode discovers skills. */
  skills?: OpenCodeSkillsConfig

  /** Named local, Git, or string reference definitions available to OpenCode. */
  references?: OpenCodeReferencesConfig

  /** Alternate singular reference table supported by OpenCode. */
  reference?: OpenCodeReferencesConfig

  /** File-watcher settings, including ignored path patterns. */
  watcher?: OpenCodeWatcherConfig

  /** Whether OpenCode records filesystem snapshots for supported workflows. */
  snapshot?: boolean

  /** OpenCode plugins, optionally paired with provider-native plugin options. */
  plugin?: OpenCodePluginConfig[]

  /** Session sharing policy: manual, automatic, or disabled. */
  share?: "manual" | "auto" | "disabled"

  /** Legacy automatic-sharing switch understood by OpenCode. */
  autoshare?: boolean

  /** Automatic update policy or notification-only mode. */
  autoupdate?: boolean | "notify"

  /** Provider identifiers OpenCode must not load. */
  disabled_providers?: string[]

  /** Provider allowlist OpenCode may load. */
  enabled_providers?: string[]

  /** Native default model; lower precedence than `OpenCodeAgentOptions.model`. */
  model?: string

  /** Smaller model used by OpenCode for lightweight internal work. */
  small_model?: string

  /** Native default Agent name; AML replaces this with its generated `aml` profile. */
  default_agent?: string

  /** Maximum nesting depth for OpenCode-native subagents. */
  subagent_depth?: number

  /** Display name OpenCode associates with the current user. */
  username?: string

  /** Legacy build, plan, and custom mode definitions. */
  mode?: OpenCodeModeConfig

  /** Native Agent profile definitions; AML preserves entries other than `aml`. */
  agent?: OpenCodeAgentProfilesConfig

  /** Provider credentials, models, endpoints, and provider-native options. */
  provider?: OpenCodeProvidersConfig

  /** Native local and remote MCP server definitions. */
  mcp?: OpenCodeMcpConfig

  /** `false` disables formatters, `true` enables defaults, and a table applies overrides. */
  formatter?: boolean | OpenCodeFormattersConfig

  /** `false` disables LSP, `true` enables defaults, and a table applies server overrides. */
  lsp?: boolean | OpenCodeLanguageServersConfig

  /** Additional instruction files or patterns loaded by OpenCode. */
  instructions?: string[]

  /**
   * Native interface layout setting.
   *
   * @deprecated The bundled OpenCode version always uses stretch layout.
   */
  layout?: "auto" | "stretch"

  /** Base native permission policy; AML's effective denials take precedence. */
  permission?: OpenCodePermissionConfig

  /** Base native tool enablement; AML's effective tool denials take precedence. */
  tools?: OpenCodeToolConfig

  /** Attachment and image-size handling limits. */
  attachment?: OpenCodeAttachmentConfig

  /** Enterprise OpenCode service configuration. */
  enterprise?: OpenCodeEnterpriseConfig

  /** Maximum lines and bytes retained from native tool output. */
  tool_output?: OpenCodeToolOutputConfig

  /** Automatic context compaction and retention settings. */
  compaction?: OpenCodeCompactionConfig

  /** Unstable OpenCode feature flags and experimental policies. */
  experimental?: OpenCodeExperimentalConfig
}
