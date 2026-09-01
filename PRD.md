# Agent Markup Language product requirements

This document records AML's product intent, architecture, and maturity boundaries. It is not a normative runtime contract; settled behavior belongs in `SPEC.md`.

## Product statement

Agent Markup Language is a TypeScript and JSX orchestration SDK for composing agents, message channels, tools, context, and execution resources. Built-in coding agents keep their native harnesses behind the Agent Client Protocol (ACP), giving AML one portable session boundary across local and sandboxed execution.

AML should make multi-agent control flow readable without:

- treating model output as executable source
- forcing every Agent into one framework-owned model loop
- replacing ordinary TypeScript control flow
- hiding provider capability differences
- requiring a separate visual graph or configuration language

## User problem

Agent applications repeatedly rebuild the same orchestration plumbing:

- resolve context
- construct messages
- call one or more agent harnesses
- expose application functions as tools
- validate structured results
- pass results into later decisions
- manage sessions, concurrency, limits, and cancellation
- acquire and release execution resources
- trace enough activity to understand failures

The workflow becomes scattered across provider SDK calls, prompt helpers, schema parsing, and resource lifecycle code. It becomes difficult to see which Agent runs when, what it can do, and how its result reaches the next step.

## Product thesis

JSX is useful for agent orchestration because it expresses nesting, children, conditional composition, and reusable components while remaining ordinary TypeScript.

AML earns a primitive when the runtime must provide behavior that a normal function cannot provide. Provider calls, capabilities, same-session turns, transactional Loop state, Sandboxes, Workspaces, live filesystem inclusion, and Agent-visible package staging qualify. A small transparent authoring primitive such as `<Block>` may also standardize a broadly shared serialization convention, but it must remain ordinary composition rather than grow lifecycle or control-flow semantics. Prompt presets, conditions, and finite application logic usually remain TypeScript.

## Target users

- TypeScript developers building multi-step agent applications
- teams with existing JavaScript functions that should become Agent tools
- coding-agent developers coordinating different provider harnesses
- developers who need explicit capability and resource boundaries
- teams that want deterministic tests for the same workflow they run live

## Initial use cases

- parallel research followed by audit and synthesis
- code review and repository investigation
- support and operational triage
- structured extraction followed by typed decisions
- autonomous work inside ephemeral Sandboxes and durable Workspaces

## Product principles

### Authored execution

Developers author the executable tree. Model output is data and is never implicitly parsed as AML.

### Provider-agnostic orchestration

AML coordinates coding-agent harnesses through ACP. It does not replace their models, credentials, native tools, skills, or internal loops. AML owns the shared ACP client lifecycle and provider-neutral semantics; thin Agent profiles own only executable selection and mappings ACP does not standardize.

### Extensible provider ecosystem

The SDK owns provider contracts, typed definition helpers, conformance suites, and the concrete Agent, Sandbox, and Workspace adapters included in the current release. Provider implementations remain isolated in private workspaces, while applications install one public package.

### TypeScript first

Use ordinary TypeScript for composition, branching, dependencies, and explicit parallelism. Add AML syntax only for distinct runtime semantics.

### Capability visibility

`<Tool>` and `<Mcp>` create invocation-scoped model grants. A JavaScript Tool may also be called directly by active application component code without granting it to a model. Native filesystem, shell, and network access is requested through optimistic `<Agent permissions>` defaults rather than repetitive Tool declarations. The active Sandbox, not ACP permission prompts, is the security boundary for model-controlled operations.

Without an active Sandbox, `<Agent>` runs according to its provider and `<Script>` uses trusted local process execution. An active Sandbox supplies the execution environment for compatible descendant Agents and Scripts and must never silently fall back to the host.

### Typed boundaries

Unknown provider and Tool data is validated at the boundary where it enters AML. Model-facing structured data must also provide JSON Schema.

Structured output has two explicit owners. An Agent `schema` prop keeps the result in ordinary AML composition as canonical JSON text, which lets nested Agents feed validated data into later prompts. Component-local `evaluate(value, schema)` is the typed collection boundary for application decisions. One Agent cannot use both forms.

FollowUps remain ordered turns in one provider-owned session. A structured contract applies only to the final authored turn, after every authored FollowUp has run. For built-in ACP profiles, omission of the submission Tool triggers exactly one shared-engine repair prompt containing the profile-specific Tool instruction and complete JSON Schema; a second omission fails the Agent. This bounded protocol recovery is owned by AML's shared ACP engine rather than individual profiles and does not establish a general workflow retry policy.

### Explicit resource ownership

Sandbox and Workspace scopes acquire, expose, save, and release resources through explicit provider contracts. Working directories are not treated as security boundaries.

Filesystem authoring follows nearest lexical ownership. Inside Sandbox, `<Include path>` and `<File>` use the live guest filesystem. Otherwise they use the active Workspace materialization. Application-owned `src` files remain live reads relative to the AML runtime cwd. Lexical placement chooses the owner; routing booleans do not duplicate that structure.

Agent Skills are staged local packages, not prompt aliases. AML copies a validated package to the canonical `.agents/skills/<name>/` suffix beneath a writable Agent-visible staging root, lets built-in profiles use native discovery where available, and supplies metadata-only discovery text otherwise. Remote registries and package installation stay in application build or image construction because AML cannot audit that supply chain safely at evaluation time.

### Observable, bounded execution

Agent calls, concurrency, depth, state transitions, and resource lifecycles must be inspectable and bounded. Observability must not silently change workflow behavior.

## Success signals

- a TypeScript developer can understand workflow order from the authored tree
- provider replacement does not require rewriting workflow components
- a third party can author and test a provider without modifying `@aml-jsx/sdk`
- installing one provider does not install unrelated provider SDKs
- capability scope is visible at each Agent boundary
- deterministic tests exercise the same AML used by live examples
- failures identify their primitive, provider, and execution identity
- a second non-review application does not require new core abstractions
- the fresh implementation remains materially smaller than the POC

## Non-goals

- standalone XML or an `.aml` language
- executing model-produced AML
- React rendering or reactive component state
- Agent-as-Tool recursion
- durable checkpoints and resume
- distributed scheduling
- a hosted AML service
- a visual workflow designer
- a universal provider capability abstraction
- a polished CLI or TUI
- automated package publication or a stable-API promise

## Implementation principles

- Build one primitive or runtime boundary at a time.
- Give every slice a deterministic behavioral proof.
- Keep the authored JSX surface provider-neutral.
- Keep provider SDK types and lifecycle inside their owning adapter package.
- Use concrete dependency injection by default.
- Use classes for state, lifecycle, scheduling, and resource ownership.
- Use functions for components, pure transformations, typed definition helpers, and configured provider factories.
- Validate unknown data at the boundary that receives it.
- Add a dependency only when the current slice would otherwise maintain meaningful generic infrastructure.
- Do not create future-facing implementations, registries, folders, packages, or exports.

## Target architecture

### Ownership boundaries

AML is developed as a workspace with four conceptual areas:

- one public SDK containing the JSX runtime, evaluator, primitives, provider contracts, built-in adapters, and conformance utilities
- private provider workspaces that isolate Agent, Sandbox, and Workspace integrations during development
- private examples that consume the built public SDK
- private applications, including the product website

Repository layout is an implementation detail. New providers and applications are added only after their requirements and delivery work are approved.

### Dependency direction

The provider-neutral dependency graph points inward, while the public SDK distribution includes the built-in adapters:

```text
applications and examples ──────► public SDK
                                       ▲
                                       │ includes
                              built-in provider adapters
                                       │
                                       ▼
                              provider-neutral contracts
```

The public SDK defines provider-neutral contracts. Concrete providers depend on those contracts, never on sibling providers. Internal workspace boundaries may organize development without becoming separate installation targets.

Importing the SDK may load provider modules but must not construct credentialed clients, inspect local profiles, contact remote services, start processes, or require local infrastructure. Providers perform environment discovery and side effects only when configured or invoked.

### Public and experimental API

Stable public API contains behavior accepted in `SPEC.md` and proven through provider-neutral tests and at least one representative integration. Working code alone does not make an abstraction stable.

`<Loop>` and `<Context>` remain experimental. Their implementations may be used for evaluation, but they are not yet commitments to a stable public contract. Promotion requires demonstrated demand, accepted semantics, and confidence that ordinary TypeScript or existing AML primitives cannot serve the same need more clearly.

### Provider boundaries

AML separates three provider responsibilities:

- The shared ACP engine owns built-in coding-agent sessions, authored turns, MCP bridges, structured-output submission and bounded repair, streaming, cancellation, and cleanup.
- Agent profiles own ACP executable selection, model and system mapping, native permission mapping, credentials, and provider-specific configuration.
- Sandbox providers own disposable execution environments and expose bounded command execution plus safe long-lived process spawning.
- Workspace providers own durable materialization, optional cross-process locking, persistence, and release.
- The active filesystem boundary owns portable stat, complete-file read, and atomic replacement write operations used by Include, File, Skill staging, and provider preparation.

These boundaries compose without pretending that every provider has identical capabilities. Unsupported combinations fail explicitly.

Built-in Agent profiles cover OpenCode, Codex, and Pi. They must all use the same ACP engine on the trusted local
host and in every supported Sandbox. Built-in Sandbox integrations cover trusted local execution, Docker, Daytona,
and Modal. Built-in Workspace integrations cover
direct local directories, staged filesystem persistence, and S3-compatible object storage through the shared
archive-or-folder persistence engine.

`AgentProvider` remains a public structural extension point. Deterministic tests and application-specific providers
may implement it directly, but a provider that claims built-in coding-agent or Sandbox portability must use ACP.

### Breaking 0.8 authoring-filesystem goal

The 0.8 line deliberately replaces the legacy prompt-text meaning of `<Skill>` rather than preserving two concepts behind one name.

- Add native `<Block>` for exact blank-line structure and optional kebab-cased model-facing sections.
- Add `<Include src>` for application-owned prompt files and `<Include path>` for live active-filesystem reads, with bounded inline content and automatic staging of oversized local sources.
- Extend `<File>` to copy local `src` text or resolved children into the nearest active filesystem, including guest-side Sandbox writes.
- Redefine `<Skill src>` as a complete local Agent Skill package with canonical materialization, provider discovery mapping, progressive disclosure, and metadata fallback.
- Add provider-neutral active-filesystem and per-Agent staging owners before implementing component behavior.
- Migrate AML's legacy `<Skill src="...md">` prompt usages to `<Include>` in the same release. Downstream applications migrate only after that SDK is published.

The release does not add `<If>`, `<Else>`, `<Map>`, or `<Sequence>`. Ordinary TypeScript remains the finite control-flow surface. `<Loop>` remains experimental and narrow because it owns validated staged state and repeated Agent sessions. A future `<Timeout>` or `<Race>` would need to own cancellation and cleanup rather than merely rename `Promise` APIs.

### Definition and capability rules

Definition helpers are provider-authoring and application-authoring tools, not registries. Each helper:

- validates its input eagerly
- returns one immutable authored value
- preserves exact identity for capability matching
- prevents mutation from changing evaluation behavior
- performs no I/O
- does not create a hidden singleton
- does not infer a provider from a string name

`defineTool()` returns a typed callable carrying its immutable model-facing declaration and explicit low-level execution method. Calling it from an active AML component runs application work; passing the same identity to `<Tool use>` grants its registered execution port to that Agent. The exact-identity registry is realm-global and weakly held so separately installed SDK copies interoperate, but it is not a discoverable name registry or source of ambient capabilities.

### Distribution and proof

AML ships as one public SDK package. Built-in adapters remain separately owned during development but are distributed from that package so applications do not coordinate versions across a family of packages.

Examples consume the built public package rather than repository internals. Provider-neutral conformance suites prove shared contracts; focused tests prove adapter behavior; credentialed or infrastructure-dependent tests remain explicit integration checks.

## Dependency strategy

Dependencies must have one clear owner and replace meaningful code AML would otherwise maintain.

- The SDK owns provider-neutral runtime, schema, cancellation, scheduling, and tracing dependencies.
- The shared ACP engine owns the ACP client SDK, process/session lifecycle, MCP bridges, and protocol translation.
- An Agent profile owns only its ACP adapter dependency and provider-specific configuration.
- Provider-specific dependencies must not leak their types or lifecycle into the AML contracts.
- Real credentials, daemons, containers, and network calls remain explicit integration concerns.
- Ordinary asynchronous evaluation continues to use platform primitives rather than a task-graph engine, service locator, or plugin container.

The future CLI remains an application over the same public SDK and evaluator. It must not introduce a second language, file format, or execution model.

## WORKER RUNTIME

This section records the Worker and remote-agent research completed in July 2026. It is an architectural option, not an approved implementation slice.

### Findings

AML's core evaluator is compatible with request-oriented isolate runtimes when the platform provides the asynchronous context and web APIs it relies on. A local Cloudflare Worker proof successfully ran JSX evaluation, nested evaluation, context propagation, and a Worker-native Agent provider.

The current battery-included SDK entry is not Worker-safe because it also reaches built-in providers with Node, process, and host-filesystem assumptions. The runtime core is viable in a Worker; the combined distribution boundary is the blocker. Local child processes and writable host filesystems should not be treated as portable Worker capabilities.

### Potential package boundary

If a concrete Worker use case is approved, the preferred distribution is a Worker-safe subpath of the existing SDK rather than another npm package. It would share the SDK release while exposing only the runtime and contracts that can execute in request/serverless environments.

The boundary should be provider-neutral and usable across Cloudflare Workers, Lambda-style functions, Modal web endpoints, and similar platforms. Cloudflare bindings belong in application composition, not AML core.

A Worker build would require an automated compatibility proof and bundle inspection so Node-only providers cannot enter its dependency graph accidentally.

### Agent execution inside Sandboxes

AML launches every built-in coding Agent through the same ACP process/session boundary. `SandboxRuntime.spawn()`
supplies provider-neutral byte streams, input, exit, cancellation, and process-tree cleanup while ACP supplies
initialization, session creation, streaming updates, prompts, and cancellation.

The Agent process runs inside the selected Sandbox beside the materialized Workspace. On the trusted local host, the
same engine uses a local process launcher. AML does not keep the Agent loop on the host while redirecting selected
shell commands into a Sandbox, because that creates different semantics for every Agent and leaves native filesystem
behavior outside the claimed execution boundary.

The environment author supplies compatible ACP executables in the selected host, image, snapshot, or Sandbox
package set. AML does not install Agents implicitly.

### ACP boundary

ACP is the canonical in-process-to-Agent protocol, not an optional generic daemon experiment. AML uses its standard
stdio transport over the process handle supplied by each Sandbox provider. A future network transport may extend
where that process runs, but must not create another Agent lifecycle.

AML continues to own workflow evaluation, authored prompts and FollowUps, typed output validation, limits, tracing,
and resource scopes. ACP owns the interoperable session exchange. The Agent owns its internal model/tool loop. The
Sandbox owns confinement and process cleanup.

### Decision

Adopt ACP as the only canonical built-in coding-agent lifecycle. Keep `AgentProvider` above ACP as AML's public
orchestration port, keep `SandboxRuntime.spawn()` below ACP as the process transport, and implement provider
differences as profiles. Do not add a second generic remote-Agent daemon, vendor SDK lifecycle, one-shot CLI path, or
embedded Agent loop.

The Worker-safe SDK entry and Cloudflare Sandbox provider remain deferred. If approved later, they must host or reach
the same ACP session engine rather than introduce a platform-specific Agent protocol.

Research references:

- [Agent Client Protocol architecture](https://agentclientprotocol.com/get-started/architecture)
- [Agent Client Protocol session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/)
- [Cloudflare Containers](https://github.com/cloudflare/containers)
- [OpenAI Codex App Server architecture](https://openai.com/index/unlocking-the-codex-harness/)
- [AgentOS](https://agentos-sdk.dev/docs/)

## Explicitly deferred

- model-produced AML execution
- Agent-as-Tool
- `defineAgent()` until it has semantics beyond a function component
- generic `defineProvider()` and provider registries
- convenience aggregator packages such as `@aml-jsx/agents`
- Effect and Flue runtimes
- React-style mutable state
- durable resume and distributed scheduling
- general workflow retry policies beyond structured-output protocol recovery
- human approval gates
- CLI and TUI
- generic plugin infrastructure
- automated package publication
- Worker-specific SDK entry and network ACP transport
- first-class Git checkout, worktree, commit, push, or pull-request behavior
- Workspace volume mounts coordinated with compatible Sandbox providers
- network-mounted Workspaces, including SMB and NFS-style filesystems
- SFTP Workspace storage
- Google Drive Workspace storage
- `<File>` append/create modes and authored binary content
- remote Skill registry resolution, installation, or package-script execution

Deferred ideas may enter the roadmap only after their behavior is accepted in `SPEC.md`.

## Working questions

These remain product questions until resolved into `SPEC.md`:

- When, if ever, should JSX siblings become implicitly concurrent?
- Which trace events are stable public API?
- What is the first useful artifact contract for large data?
- What should an Agent provider expose about inherited host configuration?
- Should a strict capability mode reject provider-inherited MCP servers that cannot be disabled?
- Should local MCP server execution location be explicit, or remain entirely adapter-owned?
- When does the CLI become more valuable than direct SDK execution?

## Idea parking lot

- human approval gates
- durable execution and resume
- richer cancellation and retry policies
- trace timeline or Gantt visualization
- interactive Agent TUI
- remote Sandbox fleets
- volume-mounted and network-mounted Workspace storage
- SFTP and Google Drive Workspace providers
- first-class Git workflows if Script proves insufficient
- Agent-as-Tool with explicit resource and budget semantics

Items in this section are not commitments and must not shape implementation until promoted into `SPEC.md` and the delivery roadmap in this document.
