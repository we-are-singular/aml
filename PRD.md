# Agent Markup Language product requirements and delivery plan

Status: Phase 1 delivered; `<Loop>` and `<Context>` remain under evaluation

This is the living product definition, architecture plan, implementation roadmap, and progress tracker for AML. It is not a normative runtime contract. Settled behavior belongs in `SPEC.md`; this document records why AML exists, how it is organized, what is being built next, and which slices have been proven.

The Phase 0 proof of concept is archived as reference material, not a build target or an architectural constraint.

## Product statement

Agent Markup Language is a TypeScript and JSX orchestration SDK for composing agents, message channels, tools, context, and execution resources while allowing each Agent to keep its native provider harness.

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

AML earns a primitive only when the runtime must provide behavior that a normal function cannot provide. Provider calls, capabilities, same-session turns, transactional Loop state, Sandboxes, and Workspaces qualify. Prompt fragments, presets, conditions, and finite application logic usually do not.

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

AML coordinates provider-owned Agent harnesses. It does not replace their models, credentials, tools, sessions, sandboxes, skills, or internal loops.

### Extensible provider ecosystem

The SDK owns provider contracts, typed definition helpers, conformance suites, and the concrete Agent, Sandbox, and Workspace adapters included in the current release. Provider implementations remain isolated in private workspaces, while applications install one public package.

### TypeScript first

Use ordinary TypeScript for composition, branching, dependencies, and explicit parallelism. Add AML syntax only for distinct runtime semantics.

### Capability visibility

An Agent receives only its declared AML capabilities. Provider-native capabilities and inherited environment behavior must remain visible rather than being presented as portable guarantees.

### Typed boundaries

Unknown provider and Tool data is validated at the boundary where it enters AML. Model-facing structured data must also provide JSON Schema.

### Explicit resource ownership

Sandbox and Workspace scopes acquire, expose, save, and release resources through explicit provider contracts. Working directories are not treated as security boundaries.

### Observable, bounded execution

Agent calls, concurrency, depth, state transitions, and resource lifecycles must be inspectable and bounded. Observability must not silently change workflow behavior.

## Phase 1 outcome

Phase 1 produced and published a provider-agnostic SDK with one public package, private provider workspaces, deterministic conformance suites, built-package examples, a credentialed Agent/Sandbox smoke matrix, and a supporting website. The CLI remains intentionally deferred.

Phase 1 proved:

1. Async JSX components evaluate once and compose bottom-up.
2. Nested Agents preserve explicit prompt and system-message dataflow.
3. JavaScript functions become scoped model-callable Tools.
4. Skills contribute reusable instructions with explicit provenance.
5. Sandbox providers own confinement and cleanup.
6. Workspace providers preserve one working tree across Sandbox runs.
7. MCP servers become explicit Agent-scoped grants owned operationally by Agent providers.
8. Independent Agents can be evaluated concurrently.
9. Structured Agent results pass through typed schemas.
10. FollowUps reuse one provider session.
11. Experimental Loop state can commit transactionally between fresh Agent iterations.
12. The same workflow can use deterministic, OpenCode, and Codex providers.
13. Traces explain execution without exposing sensitive content by default.
14. Experimental Context can provide immutable session dependencies to descendants without blocking the MVP.

The delivered component order through MVP was Agent with System, Tool, Skill, Sandbox, then Workspace. System shipped as part of the Agent message-channel boundary rather than adding a sixth independent execution boundary. MCP and richer orchestration followed after those five boundaries were proven. Loop and Context have working implementations, but remain experimental while their public value and API shape are evaluated.

## Demonstration outcome

The shared multi-agent code-review example now provides the Phase 1 demonstration:

- gather repository scope and governing instructions
- run independent focused reviewers
- pass structured findings to a capability-restricted auditor
- synthesize a final review
- show Agent, Tool, resource, timing, and usage traces
- run deterministically in tests and live through explicitly selected providers
- switch between deterministic, OpenCode, and Codex provider construction without rewriting the workflow

The example remains a proof of AML's general orchestration surface, not a reason to add review-specific concepts to the language.

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

## Original Phase 1 non-goals

These items were not acceptance criteria for the original implementation phase. Shipping the website and manually publishing prerelease packages did not promote the remaining items into the language roadmap.

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

## Delivery progress

The status table is the canonical implementation tracker. A slice moves to `Done` only after its implementation, behavioral proof, package validation, and relevant documentation are complete.

| Work     | Scope                                          | Status            |
| -------- | ---------------------------------------------- | ----------------- |
| Phase 0  | Proof of concept                               | Done and archived |
| Slice 0  | Monorepo and evaluation foundation             | Done              |
| Slice 1  | `<Agent>`, `<System>`, and provider authorship | Done              |
| Slice 2  | OpenCode Agent package                         | Done              |
| Slice 3  | `<Tool>` and `defineTool()`                    | Done              |
| Slice 4  | `<Skill>`                                      | Done              |
| Slice 5  | `<Sandbox>` contract                           | Done              |
| Slice 6  | Docker Sandbox package                         | Done              |
| Slice 7  | `<Workspace>` contract                         | Done              |
| Slice 8  | Local Workspace package and MVP completion     | Done              |
| Slice 9  | `<Mcp>` and `defineMcpServer()`                | Done              |
| Slice 10 | `evaluate()` and structured results            | Done              |
| Slice 11 | Bounded Agent concurrency                      | Done              |
| Slice 12 | `<FollowUp>`                                   | Done              |
| Slice 13 | `<Loop>`                                       | Evaluating        |
| Slice 14 | Codex Agent package                            | Done              |
| Slice 15 | Observability consumers                        | Done              |
| Slice 16 | Context                                        | Evaluating        |
| Slice 17 | Pi Agent package                               | Done              |
| Slice 18 | Daytona Sandbox package                        | Done              |
| Slice 19 | Modal Sandbox package                          | Done              |
| Slice 20 | Shared Workspace persistence and S3 provider   | Done              |
| Slice 21 | `<File>` and sandboxed `<Script>` composition  | Done              |

Allowed statuses are `Pending`, `In progress`, `Evaluating`, `Blocked`, and `Done`. `Evaluating` means a working implementation exists but is not yet accepted as stable public API. A blocked slice includes its blocker directly in the status cell.

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

- Agent providers own model or coding-harness sessions, provider-native capabilities, structured output mapping, and session cleanup.
- Sandbox providers own disposable execution environments and expose only the bounded runtime capabilities AML requires.
- Workspace providers own durable materialization, optional cross-process locking, persistence, and release.

These boundaries compose without pretending that every provider has identical capabilities. Unsupported combinations fail explicitly.

Built-in Agent integrations currently cover OpenCode, Codex, and Pi. Built-in Sandbox integrations cover trusted
local execution, Docker, Daytona, and Modal. Built-in Workspace integrations cover direct local directories, staged
filesystem persistence, and S3-compatible object storage through the shared archive-or-folder persistence engine.

### Definition and capability rules

Definition helpers are provider-authoring and application-authoring tools, not registries. Each helper:

- validates its input eagerly
- returns an opaque definition
- preserves exact identity for capability matching
- prevents mutation from changing evaluation behavior
- performs no I/O
- does not register globally
- does not create a hidden singleton
- does not infer a provider from a string name

### Distribution and proof

AML ships as one public SDK package. Built-in adapters remain separately owned during development but are distributed from that package so applications do not coordinate versions across a family of packages.

Examples consume the built public package rather than repository internals. Provider-neutral conformance suites prove shared contracts; focused tests prove adapter behavior; credentialed or infrastructure-dependent tests remain explicit integration checks.

## Dependency strategy

Dependencies must have one clear owner and replace meaningful code AML would otherwise maintain.

- The SDK owns provider-neutral runtime, schema, cancellation, scheduling, and tracing dependencies.
- A provider owns the vendor SDKs and process or network libraries required by that integration.
- Provider-specific dependencies must not leak their types or lifecycle into the AML contracts.
- Real credentials, daemons, containers, and network calls remain explicit integration concerns.
- Ordinary asynchronous evaluation continues to use platform primitives rather than a task-graph engine, service locator, or plugin container.

The future CLI remains an application over the same public SDK and evaluator. It must not introduce a second language, file format, or execution model.

## Delivery record

The numbered slices record the order in which AML reduced architectural risk. The progress table is the canonical status; this section retains only the product-level result of each phase.

### Evaluation foundation — delivered

The initial runtime proved asynchronous JSX evaluation, explicit sequential composition, transparent components and fragments, deterministic normalization, bounded execution, cancellation, and attributable failures. It also established the single-package distribution and built-package proof used by later work.

### MVP execution boundaries — delivered

Agent and System established provider-owned sessions with explicit message channels. Tool and Skill added scoped capabilities without global registration. Sandbox added disposable execution ownership, while Workspace added durable materialization that can survive multiple Sandbox runs.

OpenCode provided the first live Agent proof. Docker and local storage provided the first concrete Sandbox and
Workspace proofs.

The completed Workspace expansion added logical cwd, opt-in load and save selection, `.gitignore`-aware snapshots,
retained immutable revisions, archive and folder formats, fixed-policy optional run locks, and serialized writable
Sandbox reconciliation by default. The same persistence engine now drives staged filesystem and S3-compatible
providers; a credentialed R2 smoke proves a Docker-to-Daytona file handoff through durable object storage.

`<File>` now turns resolved AML text, including an Agent result, into a Workspace file before later siblings run.
`<Script>` executes an argument vector or explicit `sh`, `bash`, or `node` source only through an active Sandbox.
Together they cover authored setup, generated handoff files, Git commands, validation, and later-Agent input without
adding directory-copy or Git-specific primitives.

### Post-MVP orchestration — delivered

MCP grants, component-local evaluation, structured results, bounded Agent concurrency, and FollowUps are implemented and accepted. Codex added a second substantially different Agent harness. Runtime tracing and cleanup hooks made execution observable without changing workflow behavior.

### Experimental orchestration — evaluating

`<Loop>` has a working implementation for schema-validated state transitions across fresh Agent sessions. It remains experimental while AML evaluates whether the primitive is clearer and safer than ordinary TypeScript control flow, and whether its state and capability semantics are stable enough for public commitment.

`<Context>` has a working implementation for immutable lexical dependencies. It remains experimental while AML evaluates whether the convenience justifies a runtime primitive and whether its interaction with asynchronous evaluation is intuitive enough for public commitment.

Neither primitive should be described as stable public API until its status moves to `Done`.

### Provider expansion — delivered

Pi added an embedded Agent harness with a different capability profile from OpenCode and Codex. Daytona and Modal proved that the narrow Sandbox contract can map to hosted disposable environments. Local execution remains available for trusted development, and Docker remains the local image-based boundary.

These integrations intentionally preserve provider differences. AML guarantees only the common contract each adapter can honestly implement and rejects unsupported capability combinations.

### Website and release — delivered

The website, provider examples, package documentation, and manual release flow were delivered outside the numbered runtime slices. Automated publication and a polished CLI remain deferred.

## Definition of done

Before marking a slice `Done`:

- `SPEC.md` describes the complete required behavior
- public API exists only for behavior exercised by the slice
- happy paths and invalid boundaries have behavior tests
- one deterministic example is readable without runtime internals
- errors identify the responsible primitive or provider
- type checking, build, tests, and diff validation pass
- every dependency has one named owner and replaces concrete maintained code
- no unrelated primitive is partially implemented
- no placeholder abstraction or empty package exists only for future work
- provider packages pass their SDK conformance suite
- examples consume the built public package
- the resulting public API is reviewed before the next slice starts

## Immediate implementation boundary

All numbered delivery work is implemented. Slices 13 and 16 remain under product and API evaluation; every other
slice is complete. The narrow common Sandbox runtime has local, container, and hosted proofs. Workspace persistence
has staged filesystem and S3-compatible object-store proofs in both archive and folder formats. Cloudflare Workers
remain a portability check until implementation work is approved.

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

AML already bridges an active Sandbox into compatible Agent providers through a bounded command-execution contract. Existing integrations prove three useful patterns:

- run an installed coding-agent CLI inside the Sandbox
- use a provider's non-server command mode for one complete turn
- keep the Agent loop outside the Sandbox while redirecting its shell capability into the Sandbox

This is enough for bounded execution, but it is not a rich remote-agent protocol. Streaming, approvals, interruption, reconnection, durable sessions, and background-process ownership would require a different boundary. The common Sandbox contract should not absorb those capabilities before a real workflow proves they are necessary.

### Generic Sandbox Agent option

A generic Sandbox Agent could run an Agent-host daemon inside any reachable Linux environment, including local processes, Docker, Cloudflare Sandbox, Modal, or Daytona. Rivet Sandbox Agent is one candidate because it presents a common network protocol over multiple coding harnesses.

In that architecture, AML continues to own workflow evaluation, prompts, FollowUps, typed output, limits, tracing, and resource scopes. The in-sandbox daemon owns processes, stdio, Agent-specific protocols, sessions, permissions, and streaming.

The AML side should depend on an ordinary request/response transport supplied by platform composition. That keeps Cloudflare bindings out of the generic Agent implementation and allows a local AML client to reach a Cloudflare-hosted Sandbox through an authenticated service endpoint.

### Decision

Do not implement the Worker SDK entry, generic Sandbox Agent, Cloudflare Sandbox provider, or remote Agent transport yet. Together they introduce a new runtime build, daemon lifecycle, custom images, streaming transport, platform connectivity, and capability mappings without a demonstrated product need.

Revisit this path when an application must run AML inside an isolate, a Node backend is operationally unacceptable, or bounded command execution fails because the workflow requires streaming, reconnection, approvals, or durable remote sessions.

The first approved work should be a disposable compatibility spike that proves one real Agent turn, streaming, cancellation, cleanup, and Workspace handoff before any new contract is promoted into `SPEC.md`.

Research references:

- [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/)
- [Cloudflare Containers](https://github.com/cloudflare/containers)
- [OpenAI Codex App Server architecture](https://openai.com/index/unlocking-the-codex-harness/)
- [Rivet Sandbox Agent](https://github.com/rivet-dev/sandbox-agent)

## Explicitly deferred

- model-produced AML execution
- Agent-as-Tool
- `defineAgent()` until it has semantics beyond a function component
- generic `defineProvider()` and provider registries
- convenience aggregator packages such as `@aml-jsx/agents`
- Effect and Flue runtimes
- React-style mutable state
- durable resume and distributed scheduling
- retry and repair policies
- human approval gates
- CLI and TUI
- generic plugin infrastructure
- automated package publication
- Worker-specific SDK entry and generic remote Agent-host integration
- first-class Git checkout, worktree, commit, push, or pull-request behavior
- provider-native Workspace mounts and incremental folder synchronization
- SFTP or rsync Workspace storage adapters
- Workspace-owned Skill materialization
- `<File>` host sources, append/create modes, binary content, and guest-side Sandbox writes

Deferred ideas may enter the roadmap only after their behavior is accepted in `SPEC.md`.

## Working questions

These remain product questions until resolved into `SPEC.md`:

- When, if ever, should JSX siblings become implicitly concurrent?
- Which trace events are stable public API?
- What is the first useful artifact contract for large data?
- Where should retries and schema repair live?
- What capability beyond bounded Sandbox command execution is first proven necessary by a concrete remote Agent workflow?
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
- mounted or incrementally synchronized Workspace storage
- first-class Git workflows if sandboxed Script proves insufficient
- Agent-as-Tool with explicit resource and budget semantics

Items in this section are not commitments and must not shape implementation until promoted into `SPEC.md` and the delivery roadmap in this document.
