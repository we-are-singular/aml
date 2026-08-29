---
title: SDK changelog
description: Human-readable release history for @aml-jsx/sdk.
tableOfContents:
  minHeadingLevel: 2
  maxHeadingLevel: 2
---

This page tracks `@aml-jsx/sdk`. Entries are newest first. See [GitHub Releases](https://github.com/we-are-singular/aml/releases) for tags and complete release artifacts.

<!-- changelog:entries -->

## SDK v0.7.1 — Preserved OpenCode native tools and ACP tool-call summaries

Released 2026-08-29.

This patch keeps caller-disabled native OpenCode tools intact while retaining AML's portable permission denials as the final authority, and extends run summaries with a content-free tally of ACP tool-call starts.

### Highlights

- **OpenCode preserves caller-disabled native tools** The OpenCode profile no longer overwrites the tool map with a blanket `*: true` that discarded disabled native tools. It now merges native tool choices from both the top-level `tools` config and the `agent.aml.tools` layer before applying AML's portable permission denials, which remain the final authority. [OpenCode Agent](/docs/providers/agents/opencode/)
- **ACP tool-call summaries** `createTraceSummaryCollector()` now also counts ACP tool-call starts (`acp.session.update` with `tool_call`) from the trace stream, exposing each run's `acpToolCalls` as a content-free total and per-name breakdown alongside the existing span aggregates. [Observability](/docs/observability)

### Commits

- fix(agent-opencode): #36 preserve disabled native tools (96eb4b6)
- feat(sdk): #34 summarize acp tool calls (32560de)
- release(sandbox): v0.3.0 (ca0b7a2)

## SDK v0.7.0 — Parallel branches, callable Tools, and per-Agent timeouts

Released 2026-08-29.

This release introduces an explicit concurrency boundary, makes defined Tools callable from application code, adds per-Agent execution timeouts and diagnostic names, and correlates application work and run summaries in the trace stream. It also keeps structured output reliable for nested Agents and hardens permission inheritance for Codex and OpenCode subagents.

### Highlights

- **Parallel branches with an explicit concurrency boundary** New `<Parallel />` evaluates independent text-producing branches concurrently, so branches may finish in any order but contribute successful text in authored order. It waits for every branch and its Sandbox/Workspace cleanup before resolving, and surfaces any rejection as one exported ParallelError whose failures keep the authored branch index and cause. Caller cancellation still propagates, and maxConcurrentAgents remains the single limit on provider calls. [Parallel reference](/docs/reference/primitives/parallel) · [Explicit concurrency](/docs/concepts/#explicit-concurrency)
- **Defined Tools are now callable from application code** The `defineTool()` result becomes both a model-grantable Tool and a directly callable function usable inside an active component without an enclosing `<Agent />` or `<Tool />`. Calls share the same execution path, schema-validating input and revalidating and snapshotting output while inheriting cancellation and tracing, and never grant the Tool to a model. Granted Tools must reference the exact callable returned by `defineTool()`. [Tool reference](/docs/reference/primitives/tool) · [Tool or MCP](/docs/cookbook/tool-or-mcp)
- **Application observability across the trace stream** Components can time custom phases with `withTraceSpan()`, and `createTraceSummaryCollector()` derives content-free per-run summaries keyed by an explicit `runId`, with `deleteRun()` to release them. Preserved ACP message boundaries and a bounded repair turn keep structured results reliable for nested Agents. Telemetry sink failures stay isolated on `onTraceError` and never change the workflow result. [Observability](/docs/observability) · [Application observability cookbook](/docs/cookbook/application-observability)
- **Per-Agent execution timeouts and diagnostic names** A `timeoutMs` prop bounds a provider session after it acquires a scheduler slot, aborting on the earliest of timeout or enclosing cancellation and surfacing a timeout reason with elapsed `timeoutMs` in the trace. A `name` prop adds optional, non-unique diagnostic metadata for relating traces and failures to workflows, never reaching the prompt or system instructions. [Agent reference](/docs/reference/primitives/agent)
- **Delegated subagents inherit restricted permissions** Codex and OpenCode now deny restricted delegation so native child sessions cannot widen the portable AML permission set. OpenCode maps read-only filesystem, no shell, or no network into inherited edit, bash, and web deny rules; Codex keeps restricted subagents within the single AML-owned session. [OpenCode Agent](/docs/providers/agents/opencode) · [Codex Agent](/docs/providers/agents/codex)

### Commits

- feat(sdk): #30 add application observability (3f12335)
- feat(sdk): #29 make defined tools callable (c0a6a83)
- feat(sdk): #28 preserve acp message boundaries (cc67af7)
- test(sdk): cover parallel cleanup failures (0452df1)
- feat(sdk): #9 add explicit parallel boundary (a01a823)
- fix(sdk): verify acp session configuration (650ad0a)
- feat(sdk): #11 support nested structured output (0dadac0)
- fix(sdk): #22 repair missing structured output (c87e4f8)
- fix(agent-opencode): align acp launch with runtime requests (d1c9a0f)
- test(agent-codex): prove delegated sandbox inheritance (2d8bbaa)
- test(agent-opencode): prove delegated permission inheritance (d862248)
- fix(agent-codex): preserve restricted subagent delegation (d29dc5d)
- fix(agent-opencode): #20 inherit task permissions (e7494cd)
- fix(agent-codex): #20 prevent restricted subagent delegation (b188163)
- fix(agent-opencode): #20 prevent restricted task delegation (24e320b)
- fix(sdk): preserve cancellation during agent cleanup (bca0107)
- feat(sdk): #12 add per-agent execution timeouts (de044a9)
- feat(sdk): add agent diagnostic names (a20447b)
- release(sandbox): v0.2.0 (4f497bd)
- build(sandbox): update aml runtime (b0418e3)
- refactor(sandbox): align source and release lane (ca51b2e)

## SDK v0.6.0 — A portable Agent runtime image

Released 2026-08-18.

This release debuts AML's portable Agent runtime image, which packs the AML runtime and every built-in Agent provider into a published Docker image and becomes the basis for the SDK's sandbox smoke matrix. It also tightens standalone Copilot CLI launches so they never touch the operator's home directory.

### Highlights

- **New `aml-agent-sandbox` runtime image** AML now ships a ready-to-run Docker image, `wearesingular/aml-agent-sandbox`, with Docker Hub as the canonical stable registry for semantic versions and `latest` (each stable release includes provenance and an SBOM) and a mutable `dev` tag on GHCR. It is a Debian Bookworm/glibc runtime with Node.js 26, Python 3, Git, common shell/network/archive tools, and the codex, copilot, glm, opencode, and pi ACP executables pinned to the versions validated by the SDK's smoke matrix. It runs as the unprivileged `aml` user and ships its license and third-party notices. [Sandbox images](/docs/providers/sandboxes/images/) · [Image changelog](/docs/reference/changelog/sandbox/)
- **Run clean mounted workflows with the embedded AML runtime** The image embeds the `aml` CLI and `@aml-jsx/sdk`, and points `/node_modules` at the embedded dependency tree so standard ancestor resolution keeps bare imports visible even when a provider bind-mounts over `/workspace`. A clean mounted TypeScript, TSX, or JavaScript workflow can therefore run (for example `aml run /workspace/workflow.tsx`) with no local `package.json`, `node_modules`, or installation. [Sandbox images](/docs/providers/sandboxes/images/)
- **Sandbox smoke matrix runs from the AML image** The SDK smoke matrix now exercises the Docker, Daytona, and Modal Sandboxes from the published AML Agent image (a `dev` tag on GHCR during development) instead of installing Agent executables per run, and supports pinning a specific image/tag. This keeps cross-provider compatibility checks aligned with the exact Agent versions the image ships. [Compatibility](/docs/compatibility/)
- **Invocation-private Copilot CLI home** The Copilot profile now also sets `HOME` to AML's invocation-private state directory, alongside `COPILOT_HOME`. Because the standalone `copilot` CLI extracts its bundled runtime through `HOME` before it reads `COPILOT_HOME`, isolating both keeps its credentials, permissions, and session state away from the operator's home directory. [Copilot Agent](/docs/providers/agents/copilot/)

### Commits

- refactor(agent-sandbox): simplify image release contract (77d0c87)
- test(workspace-local): allow slow ci child startup (0696711)
- refactor(agent-sandbox): simplify image checks (2435653)
- feat(agent-sandbox): embed aml runtime (c73a881)
- test(sdk): allow smoke matrix image pinning (71e81b4)
- fix(agent-sandbox): preserve buildx state during releases (571510b)
- test(sdk): use ghcr dev image for sandbox smoke (7516e36)
- release(agent-sandbox): make docker hub canonical (a682373)
- test(sdk): run sandbox matrix from aml image (5cfdc08)
- feat(agent-sandbox): add portable agent runtime image (01032c9)
- fix(agent-copilot): isolate standalone cli home (535f8d8)

## SDK v0.5.2 — Add GLM as a community agent provider

Released 2026-08-17.

GLM joins Codex, Copilot, OpenCode, and Pi as a fifth built-in agent provider. The new `glmAgent()` factory launches Z.ai GLM Coding Plan models through the registry-listed, community-maintained `glm-acp-agent` ACP adapter, with Z.AI Coding Plan authentication and invocation-private session state.

### Highlights

- **New `glmAgent()` factory function** Exported from `@aml-jsx/sdk`, `glmAgent()` creates a GLM agent provider with options for command, args, environment overlay, apiKey, model, baseUrl, maxTokens, and working directory. It launches the configured command (default `glm-acp-agent`), which calls the GLM Coding Plan endpoint directly and provides file, shell, web, and image tools. [GLM Agent reference](/docs/providers/agents/glm/)
- **Z.AI Coding Plan authentication** Passing `apiKey` adds `Z_AI_API_KEY` and selects the adapter's `z-ai-api-key` authentication method; Coding Plan keys bill against plan quota rather than pay-as-you-go API credit. [GLM Agent reference](/docs/providers/agents/glm/)
- **Invocation-private adapter state** The adapter's resumable sessions are kept inside AML's session directory via `ACP_GLM_SESSION_DIR`, so adapter state stays private to each evaluation alongside the rest of the run. [GLM Agent reference](/docs/providers/agents/glm/)
- **Sandbox remains the permission boundary** Because `glm-acp-agent` exposes no portable permission surface beyond ACP protocol requests, the enclosing `<Sandbox />` stays the boundary for filesystem, shell, and network restrictions. The adapter is community-maintained, not the Z.ai ZCode harness (which has no ACP implementation), and AML does not install it implicitly. [GLM Agent reference](/docs/providers/agents/glm/)

### Commits

- feat(agent-glm): add community glm acp provider (c50c865)

## SDK v0.5.1 — Run Scripts on the trusted host with a compacted console tree

Released 2026-08-13.

This release makes `<Script />` usable without a Sandbox by executing on the trusted host, adds a per-execution working directory, and keeps the interactive console trace focused on lifecycle boundaries by omitting repetitive ACP chunk updates. New kitchen-sink smoke coverage exercises the full public surface together.

### Highlights

- **Host execution for `<Script />`** `<Script />` no longer requires an enclosing `<Sandbox />`. When no Sandbox is active, it runs the authored command or interpreted source on the trusted host from the runtime working directory, reusing the same process-tree cleanup, abort signaling, timeout, and cancellation semantics as local Agents. Host output is bounded to 4 MiB per stream. Host runs are deliberately unconfined — they inherit the AML host identity and environment — so AML surfaces them as `environment="host"` and reserves them for trusted authored automation; model-generated or untrusted source should still select an enforcing Sandbox. [Script reference](/docs/reference/primitives/script/)
- **Per-execution working directory** Both `<Script />` forms accept a `cwd` prop, a portable relative forward-slash path resolved against the runtime cwd on the host or the active Sandbox root inside a Sandbox. AML rejects absolute paths, backslashes, and parent traversal. TypeScript now models the literal-`command` and `shell`-source variants as two disjoint prop forms, so `args` is valid only with `command` and the shell form requires child source. [Script reference](/docs/reference/primitives/script/)
- **Compacted ACP console traces** The console tracer omits the repetitive `agent_message_chunk`, `agent_thought_chunk`, and `tool_call_update` ACP point events so the interactive tree stays focused on lifecycle boundaries; these events remain in the trace stream for custom sinks. The initial `tool_call` stays visible and reports the optional programmatic `toolName`. [Observability](/docs/observability)
- **Kitchen sink smoke coverage** The SDK smoke suite gained an end-to-end workflow exercising Agents, Sandboxes, Workspaces, MCP servers, Tools, Skills, Scripts, and structured output together, giving release automation a single pass over the public surface.

### Commits

- fix(sdk): suppress thought chunks in console traces (902906b)
- test(sdk): add kitchen sink smoke workflow (1bb3f3e)
- feat(sdk): compact acp console traces (b164f57)
- feat(sdk): add script working directory (cb49c16)
- feat(sdk): run script on the trusted host (348f27b)

## SDK v0.5.0 — Trace the Agent lifecycle and cancel on process signals

Released 2026-08-12.

This release makes Agent execution observable across its full lifecycle and gives application-owned Node processes a portable way to turn `SIGINT`/`SIGTERM` into a single cancellation signal. It also fixes the OpenCode profile so it no longer overrides OpenCode's native coding prompt, and lets the Copilot provider resolve during clean type-checking.

### Highlights

- **Process signal cancellation** A new `ProcessSignalCancellation` helper, exported from `@aml-jsx/sdk`, installs `SIGINT`/`SIGTERM` listeners and converts the first signal into one caller-owned `AbortSignal`. Constructing the helper explicitly opts the process in — importing the SDK does not. The first signal aborts active evaluations so AML can release Agent sessions, Sandbox leases, and Workspace scopes; a second signal exits immediately. Cleanup is bounded by the default 10-second deadline, and `exitCode` preserves status `130` (`SIGINT`) or `143` (`SIGTERM`) without an early `process.exit()`. Frameworks or supervisors that already own shutdown can pass their existing signal instead. [Runtime reference](/docs/runtime/#process-signals)
- **Agent and ACP lifecycle tracing** Agent execution now emits a dedicated `agent.session` span enclosing setup, turns, and cleanup, alongside new `sandbox.process` and `acp.session.*` point events for process spawn/kill and ACP session creation, prompt submission, streaming updates, and completion. `agent.cleanup` reports teardown explicitly, and the console tracer renders these as a nested tree from the `agent` span down through turns. Metadata-only tracing stays content-free; enabling content capture passes each serialized ACP update object through unchanged. [Observability](/docs/observability)
- **Preserved OpenCode native system prompt** Because OpenCode replaces its model-specific base coding prompt whenever a custom Agent has a non-empty `prompt`, the OpenCode profile no longer sets that field. Non-empty AML System content is instead prepended to the first user turn inside literal `<SYSTEM>` tags, while empty content adds no prelude — preserving OpenCode's native prompt while carrying the AML instructions across ACP. [OpenCode Agent](/docs/providers/agents/opencode/)
- **Clean-checkout Copilot type resolution** The SDK's `tsconfig` now maps `@aml-jsx/agent-copilot` to its source, so consumers and CI can type-check against the Copilot provider without relying on stale build output. [Copilot provider reference](/docs/providers/agents/copilot/)

### Commits

- fix(agent-opencode): preserve native system prompt (f977e1a)
- feat(sdk): trace agent and acp lifecycle (e956aad)
- feat(sdk): add process signal cancellation (11d2a4a)
- fix(sdk): resolve copilot source during type-checking (3cab6be)

## SDK v0.4.4 — Add GitHub Copilot as built-in agent provider

Released 2026-08-11.

This release adds GitHub Copilot to the AML SDK as a first-class agent provider alongside Codex, OpenCode, and Pi, enabling `copilot --acp` launches with AML permission bridging and structured output support.

### Highlights

- **New `copilotAgent()` factory function** Exported from `@aml-jsx/sdk`, the `copilotAgent()` factory creates a Copilot agent provider with options for command, args, environment overlay, model, reasoning effort, and working directory. The provider launches `copilot --acp` with invocation-private state (`COPILOT_HOME`), explicit authentication resolution (`COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN`), and AML permission-to-deny-rule mapping (`--deny-tool=write|shell|url`). [Copilot provider reference](/docs/providers/agents/copilot/) · [Agent providers overview](/docs/providers/agents/)
- **Expanded `AcpAgentLaunchContext` interface** Two new optional fields added to the shared ACP agent launch context: `amlMcpServerName?: string` (name of the invocation-owned MCP server hosting AML JavaScript Tools) and `inheritsProcessEnvironment: boolean` (whether the launched process inherits the host's `process.env`). All ACP profiles now pass these to `createLaunch()`, enabling provider-specific behavior like Copilot's environment-aware auth token resolution. [Agent primitives reference](/docs/reference/primitives/agent/)
- **Copilot permission mapping (filesystem, shell, network)** The Copilot profile translates AML permission grants into Copilot CLI deny flags and tool exclusions: `read-only` filesystem excludes edit/write tools and passes `--deny-tool=write`; `shell: false` excludes bash and passes `--deny-tool=shell`; `network: false` excludes web tools and passes `--deny-tool=url`. Deny rules take precedence over ACP approvals, narrowing the model-visible tool set. [Copilot provider reference](/docs/providers/agents/copilot/)
- **Structured output instruction for Copilot** When AML provides an output schema and the MCP server is active, the Copilot profile injects a `structuredOutputInstruction` that names the `aml_submit_result` MCP tool with the correct server prefix, instructing Copilot to call it once with the final result. [Agent primitives reference](/docs/reference/primitives/agent/)
- **Documentation and catalog updates** Added a full Copilot provider reference page and updated the cross-provider capability matrix to include GitHub Copilot as the fourth built-in agent provider alongside Codex, OpenCode, and Pi. [Agent providers overview](/docs/providers/agents/) · [Copilot provider reference](/docs/providers/agents/copilot/)

### Commits

- feat(sdk): add github copilot agent provider (cbbe572)

## SDK v0.4.3 — Recoverable structured output submissions

Released 2026-08-11.

Agents now receive actionable validation errors when submitting invalid structured output, allowing correction and retry within the same turn instead of terminal failure. The first valid submission wins; subsequent submissions are traced but ignored. This release also adds a new <code>agent.output</code> trace event for observability and an automated changelog authoring workflow.

### Highlights

- **Recoverable structured output submissions** The <code>aml_submit_result</code> tool now validates each submission against the output schema before accepting it. Invalid submissions return a tool error with the validation failure, allowing the agent to retry within the same turn. After the first valid submission is accepted, later submissions are silently ignored with a success response. Early submissions (before the final authored turn) are also retriable rather than terminal. [Structured output cookbook](/docs/cookbook/structured-output) · [Agent primitives reference](/docs/reference/primitives/agent)
- **Structured output schema validation** The bridge now calls the application-owned schema's validate method on each submission before accepting it. Validation failures are returned to the agent as tool errors containing the error message and cause. Validation is performed through <code>AgentStructuredOutputServices</code>, a shared registry that uses <code>Symbol.for</code> to work across multiple physical copies of the SDK in one JavaScript realm. [Runtime architecture](/docs/runtime)
- **New <code>agent.output</code> trace event** A new <code>agent.output</code> trace event fires on every <code>aml_submit_result</code> call with a call number and status of 'accepted', 'ignored', or 'invalid'. This provides structured observability into the submission lifecycle: you can see how many attempts an agent made, which attempt was accepted, and whether earlier attempts were rejected by validation or arrived before the turn was ready. [Observability](/docs/observability)
- **Automated changelog authoring workflow** The SDK and CLI release-it configurations now run a changelog generation script as part of the <code>after:bump</code> hook, which produces markdown changelog entries and stages them. The generated changelog is formatted and committed automatically. [SDK changelog](/docs/reference/changelog/sdk) · [CLI changelog](/docs/reference/changelog/cli)

### Commits

- fix(sdk): share structured output services (2b4fa27)
- fix(sdk): recover structured output submissions (261e748)
- fix(sdk): stream release hook traces (1ba1c80)
- fix(sdk): review generated changelog formatting (f494035)
- fix(sdk): trace changelog authoring (a21ad63)
- fix(sdk): preserve authored changelog markdown (dd58489)
- fix(sdk): format generated changelog entries (09be3c1)
- feat(sdk): add aml-authored changelog workflow (a8e9e60)

## SDK v0.4.2 — Independent package release lanes

Released 2026-08-10.

SDK and CLI publishing gained independent release lanes, allowing each package to advance on its own version and tag history without conflating their changes.

### Highlights

- **Package-specific releases.** Release tooling now distinguishes SDK tags from CLI tags and keeps their generated notes scoped to the package being published. [CLI reference](/docs/cli/)

### Commits

- tools: isolate package release lanes (21bca45)

## SDK v0.4.1 — Unified workspace builds

Released 2026-07-31.

The repository consolidated its Turbo task graph so SDK builds and package checks run consistently from both package and root workflows.

### Highlights

- **Consistent build ownership.** Workspace tasks now share the same root orchestration instead of maintaining overlapping build paths. [Deployment](/docs/production/deployment/)

### Commits

- build: unify turbo workspace tasks (4522d7a)

## SDK v0.4.0 — A sharper ACP execution boundary

Released 2026-07-31.

Agent execution was standardized around Agent Client Protocol sessions, with clearer process ownership, capability translation, cleanup, and failure handling across built-in providers.

### Highlights

- **Shared ACP lifecycle.** Agent providers now use one execution architecture for session startup, turns, Tools, MCP, structured output, and teardown. [Agent providers](/docs/providers/agents/)
- **Closed process gaps.** Failure and cleanup behavior was tightened around the provider process boundary. [Runtime reference](/docs/reference/runtime/)
- **More reliable Workspaces.** Local Sandbox resolution and cross-process lock startup gained focused fixes and regression coverage. [Workspace providers](/docs/providers/workspaces/)

### Commits

- fix(sdk): close acp process boundary gaps (2f4d42d)
- refactor(sdk): sharpen acp process architecture (4f8185e)
- refactor(sdk): standardize agent execution on acp (6b2c758)
- test(workspace): allow cross-process lock startup (6b235ec)
- fix(workspace): resolve local sandbox in clean tests (9290668)

## SDK v0.3.1 — S3 Workspace type resolution

Released 2026-07-30.

This patch corrected how the SDK resolves the S3 Workspace implementation during clean typechecking.

### Highlights

- **Clean-checkout type safety.** Consumers and CI can resolve the S3-backed Workspace without relying on stale build output. [S3 Workspace](/docs/providers/workspaces/s3/)

### Commits

- fix(sdk): resolve s3 workspace during typecheck (2d81fdd)

## SDK v0.3.0 — S3-compatible durable Workspaces

Released 2026-07-30.

AML added durable Workspace persistence backed by S3-compatible object storage, including revision data, ownership locks, and cleanup behavior.

### Highlights

- **Remote persistence.** Workflows can materialize and publish durable state through an S3-compatible provider. [S3 Workspace](/docs/providers/workspaces/s3/)

### Commits

- feature(workspace): add s3-compatible persistence (29f6426)

## SDK v0.2.0 — Portable provider lifecycles

Released 2026-07-29.

Provider lifecycle contracts were standardized and the Sandbox catalog expanded with Modal, while Daytona configuration moved to the shared root boundary.

### Highlights

- **Modal Sandboxes.** AML can provision remote Modal execution environments through the built-in provider. [Modal Sandbox](/docs/providers/sandboxes/modal/)
- **Consistent lifecycle contracts.** Providers now share clearer startup, acquisition, release, and failure expectations. [Provider authoring](/docs/reference/provider-authoring/)
- **Simpler Daytona configuration.** Environment selection moved out of nested implementation details. [Daytona Sandbox](/docs/providers/sandboxes/daytona/)

### Commits

- refactor(sandbox-daytona): move environment selection to root (2bf27cb)
- feature(sandbox-modal): add modal sandbox provider (d0fe6c8)
- refactor(sdk): standardize provider lifecycle contracts (6f2882a)

## SDK v0.1.3 — Pi and the portable Sandbox matrix

Released 2026-07-29.

The Agent catalog gained Pi support and AML established a portable Sandbox runtime exercised across every built-in Agent provider.

### Highlights

- **Pi Agent support.** Workflows can select Pi and its extensible MCP/tooling path. [Pi Agent](/docs/providers/agents/pi/)
- **Cross-provider confidence.** The Sandbox smoke matrix now exercises Agent and Sandbox combinations through the same portable contracts. [Compatibility](/docs/compatibility/)

### Commits

- feature(sandbox): run all agents across sandbox providers (a7353de)
- feature(sandbox): add portable runtime and smoke matrix (e3383ca)
- feature(sdk): add pi agent integration (47fadd2)

## SDK v0.1.2 — Reliable OpenCode process output

Released 2026-07-28.

OpenCode process streams are now piped through the provider boundary correctly, and SDK releases keep the root lockfile synchronized.

### Highlights

- **Visible OpenCode output.** Provider process stdout and stderr now follow the expected ACP execution path. [OpenCode Agent](/docs/providers/agents/opencode/)
- **Reproducible publishing.** Release bumps update the shared package lock before the release commit is created.

### Commits

- fix(agent-opencode): pipe opencode process output (00cd62f)
- fix(sdk): keep release lockfile synchronized (6712a41)

## SDK v0.1.1 — The first public AML SDK

Released 2026-07-28.

The first public package established AML's asynchronous JSX runtime and its core Agent, Tool, MCP, Sandbox, Workspace, Skill, FollowUp, Loop, context, evaluation, and observability boundaries.

### Highlights

- **Composable Agent workflows.** JSX became an executable dependency tree with bounded Agent concurrency and structured component evaluation. [Concepts](/docs/concepts/)
- **Scoped capabilities.** Tools, MCP servers, Skills, and same-session FollowUps gained explicit ownership inside an Agent. [Primitives](/docs/reference/primitives/)
- **Execution and durability.** Docker Sandboxes and local Workspaces established separate command and persistence boundaries. [Provider contracts](/docs/reference/providers/)
- **Built-in coding Agents.** The initial package included Codex and OpenCode provider adapters. [Agent providers](/docs/providers/agents/)

### Commits

- release(sdk): prepare unified public package (7efe97d)
- refactor(agent-opencode): separate option capture (d87da81)
- fix(runtime): isolate evaluation event subscribers (3999a92)
- feature(runtime): add evaluation lifecycle events (917894a)
- feature(context): add immutable dependency scope (71e64db)
- feature(observability): add evaluation traces (936ad3b)
- feature(agent-codex): add Codex provider adapter (36a66d6)
- feature(loop): add transactional Agent state (4f1e876)
- feature(follow-up): add same-session Agent turns (6dc0cf9)
- feature(runtime): bound Agent concurrency (91649bb)
- feature(evaluate): add structured component data (4323f1d)
- feature(mcp): add scoped server capabilities (069be42)
- feature(workspace-local): add durable local provider (4902aa4)
- feature(sandbox-docker): attach Workspace materializations (5c78719)
- feature(sdk): add durable Workspace boundary (6559c4c)
- feature(sandbox-docker): add Docker confinement provider (f0bea60)
- feature(sandbox): add provider-neutral execution scope (8ff8840)
- feature(skill): add local and inline instructions (6edc831)
- feature(tool): add scoped JavaScript capabilities (f0c96e6)
- feature(agent-opencode): add OpenCode provider adapter (5be0e73)
- feature(sdk): establish AML evaluation and Agent boundaries (1e5bbfd)
