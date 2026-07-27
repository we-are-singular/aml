# Agent Markup Language

Agent Markup Language (AML) is a TypeScript and JSX runtime for composing provider-agnostic agent workflows.

The project is being rebuilt from the Phase 0 proof of concept:

- [SPEC.md](./SPEC.md) defines required AML behavior.
- [PRD.md](./PRD.md) defines the product, architecture, implementation roadmap, and delivery status.
- [`poc/`](./poc/) preserves disposable prototype code and research.

The Phase 1 rebuild is organized as reviewed implementation slices:

- `@aml/sdk` exports the automatic JSX runtime and `AmlRuntime`.
- Components are invoked once per evaluated occurrence.
- Arrays, Fragments, Promises, empty values, strings, and numbers resolve deterministically into one string.
- `examples/basic` runs unbuilt TSX through vite-node while importing the SDK exclusively through its built `dist` exports.

Slice 1 adds provider-neutral `<Agent>` and `<System>` boundaries, `defineAgentProvider()`, deterministic fixtures under `@aml/sdk/testing`, Agent-call budgets, and cross-package primitive identity. `examples/agent` demonstrates a child Agent generating system text for its parent.

Slice 2 adds the independently installable `@aml/agent-opencode` adapter. It starts OpenCode lazily with private ephemeral databases for package-owned hosts, creates and cleans up one session per Agent, propagates cancellation, disables undeclared tools, and exposes a narrow injected session-client port for deterministic tests.

Slice 3 adds Agent-scoped `<Tool>` grants and `defineTool()`. JavaScript Tools use Standard Schema for runtime validation and Standard JSON Schema for model declarations, retain exact cross-copy identity, and return immutable JSON. The OpenCode adapter exposes them through authenticated invocation-scoped MCP bridges on disposable OpenCode hosts so dynamic registrations cannot accumulate. `examples/opencode` proves a credentialed `opencode-go/minimax-m3` model can call a process-local async function through built package exports.

Slice 4 adds `<Skill>` as local or inline instruction text. Local files are read during each evaluation, inline children resolve through ordinary AML, and both forms can be combined with optional deterministic name and description labels. It deliberately has no remote downloader, registry, cache, or provider-specific Skill API. `examples/skill` proves the built SDK reads a local Skill into an Agent prompt.

Slice 5 adds provider-neutral `<Sandbox>` scopes, `defineSandboxProvider()`, opaque leases, restrictive nested policy views, and an explicit compatibility handshake for Agent providers. AML acquires one outer lease before descendant work and releases it exactly once after success, failure, or cancellation; providers remain responsible for real confinement. `examples/sandbox` proves the built SDK passes a narrowed session to an Agent and cleans up its deterministic lease.

Slice 6 adds the independently installable `@aml/sandbox-docker` adapter. Its Dockerode-backed factory creates one same-host container per outer Sandbox lease with a confined bind mount, no network, no Linux capabilities, a non-root numeric UID, resource limits, bounded command output, and failure-safe cleanup. `examples/docker` proves an Agent-local working directory and the primary confinement settings against a real Docker daemon.

Slice 7 adds provider-neutral `<Workspace>` scopes and `defineWorkspaceProvider()`. One top-level Workspace acquires an exclusive durable materialization, passes its immutable reference to sequential outer Sandboxes, saves partial work after success or failure, and releases exactly once. `examples/workspace` proves two disposable Sandboxes sharing one materialization through built SDK exports.

Slice 8 completes the MVP with the independently installable `@aml/workspace-local` adapter. Its configured `localWorkspace()` factory maps one existing directory into a direct durable materialization, canonicalizes symlinks, rejects concurrent writers through a renewable cross-process lock, and reports stale-lock compromise honestly rather than claiming fencing. `examples/workspace-local` proves filesystem changes survive separate SDK evaluations through built package exports.

Slice 9 adds Agent-scoped `<Mcp>` grants and `defineMcpServer()` descriptors for provider-native names, local stdio servers, and remote Streamable HTTP servers. MCP configuration remains provider data rather than prompt text; the OpenCode adapter attaches it on a disposable host, validates shared Tool namespaces before prompting, and disconnects it during session cleanup. `examples/mcp` proves configured grants remain isolated from sibling Agents, while the opt-in OpenCode integration exercises a real configured MCP Tool call.

Slice 10 adds component-local `evaluate()` for ordinary awaited text or typed structured Agent results. Schema-bearing calls accept the combined Standard Schema and Standard JSON Schema contract, send only an immutable draft 2020-12 JSON document to the provider, validate the returned value at the Agent boundary, and never suspend or rerender the component. `examples/structured` passes a Zod 4 result from one specialist into a later coordinator through built package exports.

Slice 11 adds one bounded Agent scheduler per evaluation domain. Independent components opt into concurrency with ordinary `Promise.all()`, ready provider calls enter a FIFO queue, cancellation rejects queued calls before their providers start, and `maxConcurrentAgents: 0` remains explicitly unlimited. `examples/concurrency` runs two specialists in parallel and preserves authored result order for their coordinator.

Slice 12 adds static flat `<FollowUp>` turns inside one Agent session. AML resolves the complete turn plan before provider execution, keeps Tool and MCP capabilities attached for the whole session, applies structured output only to the final turn, returns only the final response, and bounds authored inputs with `maxTurnsPerAgent`. `examples/follow-up` proves three authored turns enter one dist-backed session plan in declaration order.

Slice 13 adds `<Loop>` for schema-validated transactional state between fresh Agent sessions. Each iteration receives one deeply frozen snapshot and one expiring `aml_set_state` capability on its selected outer Agent. Valid patches remain staged through the complete session, changed state discards stale output and commits into the next iteration, and stable state returns the current output. `examples/loop` proves the built SDK commits once and starts a new provider session with the updated prompt.

Slice 14 adds the independently installable `@aml/agent-codex` adapter. It creates one fresh Codex thread per Agent, preserves FollowUps in that thread, applies read-only provider defaults, attaches authored JavaScript Tools and MCP servers, supports strict structured output, and inherits normal host Codex configuration without claiming capability isolation. `examples/review` runs the same two-specialist parallel review and synthesis workflow through deterministic, OpenCode, or Codex harnesses by changing only provider construction.

Slice 15 adds evaluation-local observability with immutable provider-neutral spans and point events, content redaction by default, failure-isolated sinks, and a dependency-free console tree. Provider calls, components, resource scopes, Tools, capabilities, turns, and Loop transitions share one attributable trace hierarchy. `examples/observability` demonstrates deterministic tracing and an optional live Codex run.

Slice 16 adds exact-identity immutable Context with `createContext()`, `<Context.Provider>`, and synchronous `useContext()`. Nested and concurrent branches receive persistent lexical scopes without setters, subscriptions, suspension, or rerenders. `examples/context` captures a session repository in a JavaScript Tool closure without adding that dependency to Agent prompt text.

Nothing under `poc/` is part of the new package or public API.

```sh
npm run build
npm run typecheck
npm run test
npm run pack:check
npm run example:basic
npm run example:concurrency
npm run example:context
AML_CODEX_MODEL=gpt-5.3-codex-spark npm run example:codex
npm run example:agent
npm run example:docker
npm run example:follow-up
npm run example:loop
npm run example:mcp
npm run example:observability
npm run example:opencode
npm run example:review
npm run example:review:opencode
npm run example:sandbox
npm run example:skill
npm run example:structured
npm run example:workspace
npm run example:workspace-local
```

`npm run example:opencode` is an explicit live model call. Set `AML_OPENCODE_MODEL` to override its default model.

`npm run example:codex` is an explicit live model call through the installed Codex SDK and CLI. Set `AML_CODEX_MODEL` to override its default `gpt-5.3-codex-spark` model.

`npm run example:docker` requires a running same-filesystem Docker daemon, a host workspace writable during acquisition, and an `alpine:3.22` image by default. Set `AML_DOCKER_IMAGE` to use another image that provides POSIX `sh` and `sleep`.
