# Agent Markup Language product requirements and delivery plan

Status: Phase 1 — planned Slices 0–16 complete

This is the living product definition, architecture plan, implementation roadmap, and progress tracker for AML. It is not a normative runtime contract. Settled behavior belongs in `SPEC.md`; this document records why AML exists, how it is organized, what is being built next, and which slices have been proven.

The Phase 0 proof of concept is parked under `poc/`. It is reference material, not a build target or an architectural constraint.

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

## Phase 1 objective

Produce a small local SDK whose architecture, semantics, and optional-provider package boundaries are convincing before adding a polished CLI or publishing packages.

Phase 1 should prove:

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
11. Loop state commits transactionally between fresh Agent iterations.
12. The same workflow can use deterministic, OpenCode, and Codex providers.
13. Traces explain execution without exposing sensitive content by default.
14. Context eventually provides immutable session dependencies to descendants without blocking the MVP.

The component delivery order through MVP is Agent with System, Tool, Skill, Sandbox, then Workspace. System ships as part of the Agent message-channel boundary rather than adding a sixth independent execution boundary. MCP, richer orchestration, and Context follow only after those five boundaries have been proven; Context is intentionally last because it is useful composition infrastructure rather than a prerequisite for the execution model.

## Demonstration candidate

The leading Phase 1 demonstration remains multi-agent code review:

- gather repository scope and governing instructions
- run independent focused reviewers
- pass structured findings to a capability-restricted auditor
- synthesize a final review
- show Agent, Tool, resource, timing, and usage traces
- run deterministically in tests and live through explicitly selected providers
- optionally run repository access inside a read-only Sandbox

This is a candidate, not a reason to add review-specific concepts to AML.

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

## Non-goals for Phase 1

- standalone XML or an `.aml` language
- executing model-produced AML
- React rendering or reactive component state
- Agent-as-Tool recursion
- durable checkpoints and resume
- distributed scheduling
- a hosted AML service
- a visual workflow designer
- a universal provider capability abstraction
- a polished TUI
- npm publication

## Delivery progress

The status table is the canonical implementation tracker. A slice moves to `Done` only after its implementation, behavioral proof, package validation, and relevant documentation are complete.

| Work     | Scope                                          | Status            |
| -------- | ---------------------------------------------- | ----------------- |
| Phase 0  | Proof of concept preserved under `poc/`        | Done and archived |
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

Allowed statuses are `Pending`, `In progress`, `Blocked`, and `Done`. A blocked slice includes its blocker directly in the status cell.

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

### Monorepo layout

Phase 1 starts as an npm 11 workspace managed by Turborepo:

```text
.
├── apps/
│   ├── cli/
│   ├── docs/
│   └── site/
├── sdk/
│   ├── src/
│   ├── tests/
│   ├── package.json
│   └── vite.config.ts
├── examples/
│   ├── src/
│   │   ├── capabilities/
│   │   ├── core/
│   │   ├── integrations/
│   │   ├── resources/
│   │   └── shared/
│   ├── test/
│   │   ├── __snapshots__/
│   │   └── examples.test.ts
│   └── run.ts
├── providers/
│   ├── agents/
│   │   ├── opencode/
│   │   ├── codex/
│   │   └── claude/
│   ├── sandboxes/
│   │   ├── local/
│   │   ├── docker/
│   │   ├── daytona/
│   │   └── cloudflare/
│   └── workspaces/
│       ├── local/
│       └── s3/
├── poc/
├── PRD.md
├── SPEC.md
├── package.json
└── turbo.json
```

This is a target ownership map, not a request to create empty directories or packages. A package is created only when its implementation slice begins. `apps/` and advanced examples remain absent until their own approved slices.

The root workspace globs are:

```json
{
  "workspaces": ["apps/*", "examples", "sdk", "providers/*/*"]
}
```

The root owns orchestration scripts and shared development policy. It does not publish runtime code.

The repository has one public build target: `@aml-jsx/sdk`. The SDK owns `sdk/vite.config.ts`, and its Vite build follows the complete public source graph, including the built-in provider workspaces. Those workspaces do not need intermediate builds or copied `dist` directories for publication.

Turborepo orchestrates workspace checks and builds. Provider workspaces keep their own focused builds and package checks for development, while the SDK publication build consumes their source through explicit aliases and emits the only public package.

### Package identities

| Directory                    | Workspace                  | Responsibility                                                                                                           |
| ---------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `sdk`                        | `@aml-jsx/sdk`             | Public AML package: JSX runtime, evaluator, primitives, provider contracts, built-in adapters, and conformance utilities |
| `providers/agents/opencode`  | `@aml-jsx/agent-opencode`  | Private OpenCode adapter boundary                                                                                        |
| `providers/agents/codex`     | `@aml-jsx/agent-codex`     | Private Codex adapter boundary                                                                                           |
| `providers/agents/pi`        | `@aml-jsx/agent-pi`        | Private Pi SDK adapter boundary                                                                                          |
| `providers/sandboxes/docker` | `@aml-jsx/sandbox-docker`  | Private Docker Sandbox boundary                                                                                          |
| `providers/workspaces/local` | `@aml-jsx/workspace-local` | Private local Workspace boundary                                                                                         |

Provider workspace names organize development and are not public installation targets. The public package exports their configured factories from `@aml-jsx/sdk`.

### Dependency direction

The dependency graph points inward:

```text
apps and examples
        │
        ├──────────────► concrete provider packages
        │                          │
        └──────────────────────────┤
                                   ▼
                               @aml-jsx/sdk
```

`@aml-jsx/sdk` defines provider-neutral contracts. Concrete provider sources remain isolated in private workspaces, while the current single-package distribution bundles their factories into the SDK root and declares required vendor SDKs as runtime dependencies. Provider workspaces do not depend on sibling providers.

Importing `@aml-jsx/sdk` may load vendor modules but must not construct credentialed clients, inspect local profiles, contact remote services, or require a Docker daemon. A concrete provider performs environment discovery and side effects only when its factory is acquired or an Agent run begins.

### SDK source layout

`sdk` uses one domain-first source tree:

```text
sdk/
├── package.json
├── tsconfig.build.json
├── vite.config.ts
├── src/
│   ├── index.ts
│   ├── jsx-dev-runtime.ts
│   ├── jsx-runtime.ts
│   ├── core/
│   │   ├── aml-node.ts
│   │   ├── aml-runtime.ts
│   │   ├── evaluation-context.ts
│   │   ├── evaluation-error.ts
│   │   └── trace-identity.ts
│   ├── components/
│   │   ├── agent/
│   │   │   ├── agent.tsx
│   │   │   ├── agent-execution-context.ts
│   │   │   ├── agent-provider.ts
│   │   │   ├── agent-request.ts
│   │   │   ├── agent-response.ts
│   │   │   ├── agent-executor.ts
│   │   │   ├── define-agent-provider.ts
│   │   │   └── validate-agent-provider.ts
│   │   ├── system/
│   │   │   └── system.tsx
│   │   ├── follow-up/
│   │   │   └── follow-up.tsx
│   │   ├── tool/
│   │   │   ├── tool.tsx
│   │   │   └── define-tool.ts
│   │   ├── mcp/
│   │   │   ├── mcp.tsx
│   │   │   └── define-mcp-server.ts
│   │   ├── skill/
│   │   │   ├── skill.tsx
│   │   │   └── skill-evaluator.ts
│   │   ├── context/
│   │   │   ├── aml-context.ts
│   │   │   ├── context-registry.ts
│   │   │   ├── context-scope.ts
│   │   │   ├── create-context.ts
│   │   │   └── use-context.ts
│   │   ├── loop/
│   │   │   ├── loop-agent-selector.ts
│   │   │   ├── loop-evaluator.ts
│   │   │   └── loop.tsx
│   │   ├── sandbox/
│   │   │   ├── sandbox.tsx
│   │   │   ├── sandbox-provider.ts
│   │   │   └── define-sandbox-provider.ts
│   │   └── workspace/
│   │       ├── workspace.tsx
│   │       ├── workspace-provider.ts
│   │       └── define-workspace-provider.ts
│   ├── observability/
│   │   ├── trace-event.ts
│   │   └── trace-sink.ts
│   ├── testing.ts
│   └── testing/
│       ├── agent-provider-conformance.ts
│       ├── deterministic-agent-provider.ts
│       ├── sandbox-provider-conformance.ts
│       └── workspace-provider-conformance.ts
└── tests/
```

This tree is a target map. Each slice creates only the files it implements.

`core/` owns evaluator-wide behavior: AML nodes, component invocation, evaluation domains, ambient context, budgets, cancellation, scheduling, and cross-primitive errors.

`components/<name>/` owns one public AML concept: its component or public function, descriptors, feature-local contracts, validation, errors, and behavior tests.

`observability/` owns provider-neutral trace contracts, the evaluation-scoped dispatcher, and the dependency-free console consumer. OpenTelemetry may become a focused consumer package only after the stable event stream proves that dependency is useful.

`testing/` is exported as `@aml-jsx/sdk/testing`. It provides deterministic fixtures and reusable conformance suites without adding production-provider dependencies to the SDK.

There is deliberately no `lib/`, `utils/`, or global `types.ts` namespace. JSON parsing belongs at the schema boundary using it. RPC belongs to the provider using that transport. Console presentation belongs to observability. String logic remains local until a shared domain concept appears.

### Provider package layout

Every concrete adapter is a self-contained package:

```text
providers/agents/opencode/
├── package.json
├── turbo.json
├── tsconfig.build.json
├── tsconfig.json
├── vite.config.ts
├── scripts/
│   └── check-package.ts
├── src/
│   ├── index.ts
│   ├── opencode-agent.ts
│   ├── opencode-sdk-client.ts
│   ├── opencode-session-client.ts
│   └── opencode-session.ts
└── tests/
    ├── opencode-agent.test.tsx
    └── opencode-agent.integration.test.tsx
```

Its public factory owns provider-specific configuration:

```ts
export function opencodeAgent(options: OpenCodeAgentOptions): AgentProvider {
  return defineAgentProvider({
    name: "opencode",
    async run(request, context) {
      return runOpenCode(options, request, context)
    },
  })
}
```

The factory is synchronous and side-effect-free. It captures configuration and returns an immutable adapter. Client creation, credentials, network calls, processes, and leases occur only in the lifecycle method that needs them.

Every official provider package uses the same public `defineAgentProvider()`, `defineSandboxProvider()`, or `defineWorkspaceProvider()` helper available to third-party authors. Provider names must already be non-empty and trimmed; definition helpers validate rather than rewrite inferred identity values. The package must pass the corresponding suite from `@aml-jsx/sdk/testing`.

### Definition helper rules

The SDK exposes role-specific helpers:

| Helper                      | Defines                                 |
| --------------------------- | --------------------------------------- |
| `defineTool()`              | A model-callable JavaScript capability  |
| `defineMcpServer()`         | An explicit MCP server grant            |
| `defineAgentProvider()`     | An adapter for an Agent harness         |
| `defineSandboxProvider()`   | An adapter for ephemeral execution      |
| `defineWorkspaceProvider()` | An adapter for durable filesystem state |

Provider helpers preserve exact generic inference, validate stable identity and required lifecycle methods, and return the public provider contract. Provider names must already be non-empty and trimmed so runtime values cannot contradict inferred literal types. Helpers do not perform I/O, construct external clients, acquire resources, register global state, or hide vendor-specific options.

There is no generic `defineProvider()` because the three provider roles have materially different contracts. There is no `defineWorkspace()` because `<Workspace>` already names the authored runtime primitive. `defineAgent()` remains deferred: ordinary async function components already define reusable Agent compositions, and the SDK should add the name only when it owns distinct semantics.

Interfaces remain public and structurally implementable. Third-party packages may implement them directly, but the definition helpers are the canonical authoring path and all implementations must pass the same conformance contract.

### File and export rules

Each implementation file has one primary export whose name matches the filename:

| File                                | Primary export                 |
| ----------------------------------- | ------------------------------ |
| `aml-runtime.ts`                    | `AmlRuntime`                   |
| `evaluation-context.ts`             | `EvaluationContext`            |
| `trace-identity.ts`                 | `AmlTraceIdentity`             |
| `agent.tsx`                         | `Agent`                        |
| `agent-execution-context.ts`        | `AgentExecutionContext`        |
| `agent-provider.ts`                 | `AgentProvider`                |
| `agent-request.ts`                  | `AgentRequest`                 |
| `agent-response.ts`                 | `AgentResponse`                |
| `define-agent-provider.ts`          | `defineAgentProvider`          |
| `agent-executor.ts`                 | `AgentExecutor`                |
| `agent-output-request.ts`           | `AgentOutputRequest`           |
| `aml-model-schema.ts`               | `AmlModelSchema`               |
| `validate-agent-provider.ts`        | `validateAgentProvider`        |
| `system.tsx`                        | `System`                       |
| `follow-up.tsx`                     | `FollowUp`                     |
| `skill.tsx`                         | `Skill`                        |
| `skill-evaluator.ts`                | `SkillEvaluator`               |
| `tool.tsx`                          | `Tool`                         |
| `agent-tool.ts`                     | `AgentTool`                    |
| `define-tool.ts`                    | `defineTool`                   |
| `tool-definition.ts`                | `ToolDefinition`               |
| `tool-collection.ts`                | `ToolCollection`               |
| `json-snapshot.ts`                  | `JsonSnapshot`                 |
| `standard-schema-adapter.ts`        | `StandardSchemaAdapter`        |
| `model-schema.ts`                   | `ModelSchema`                  |
| `component-evaluation-context.ts`   | `ComponentEvaluationContext`   |
| `agent-scheduler.ts`                | `AgentScheduler`               |
| `evaluate.ts`                       | `evaluate`                     |
| `tool-input-error.ts`               | `ToolInputError`               |
| `tool-output-error.ts`              | `ToolOutputError`              |
| `mcp.tsx`                           | `Mcp`                          |
| `aml-mcp-server.ts`                 | `AmlMcpServer`                 |
| `define-mcp-server.ts`              | `defineMcpServer`              |
| `mcp-collection.ts`                 | `McpCollection`                |
| `loop-agent-selector.ts`            | `LoopAgentSelector`            |
| `loop-evaluator.ts`                 | `LoopEvaluator`                |
| `loop.tsx`                          | `Loop`                         |
| `opencode-capability-attachment.ts` | `OpenCodeCapabilityAttachment` |
| `create-isolated-opencode.ts`       | `createIsolatedOpencode`       |
| `docker-sandbox.ts`                 | `dockerSandbox`                |
| `local-workspace.ts`                | `localWorkspace`               |
| `opencode-agent.ts`                 | `opencodeAgent`                |
| `codex-agent.ts`                    | `codexAgent`                   |
| `codex-capability-attachment.ts`    | `CodexCapabilityAttachment`    |
| `codex-client-factory.ts`           | `CodexClientFactory`           |
| `codex-sdk-client-factory.ts`       | `CodexSdkClientFactory`        |
| `codex-session.ts`                  | `CodexSession`                 |
| `codex-tool-bridge.ts`              | `CodexToolBridge`              |
| `prepare-codex-output-schema.ts`    | `prepareCodexOutputSchema`     |
| `trace-sink.ts`                     | `TraceSink`                    |
| `aml-json-value.ts`                 | `AmlJsonValue`                 |

Private helpers and private types stay in the owning file. A supporting export gets its own file only when another module consumes it as an independent contract.

Exceptions:

- `index.ts` is the reviewed public export manifest for one package.
- `testing.ts` is the reviewed `@aml-jsx/sdk/testing` public subpath manifest.
- `jsx-dev-runtime.ts` exposes the development functions required by TypeScript and Vite's automatic JSX runtime contract.
- `jsx-runtime.ts` exposes the functions required by TypeScript's automatic JSX runtime contract.
- a schema may export its inferred type when the schema is the canonical contract source.

Use kebab-case filenames. Avoid internal barrels. A package's root `index.ts` may expose its intentionally small public surface.

Every exported type, class, function, and public method has a contract docblock. Long or non-obvious functions use local section comments, and branches that encode ordering, trust, ownership, cleanup, or compatibility decisions explain why that decision exists. Comments must describe current behavior accurately rather than narrating obvious syntax.

### Examples and built-package proof

All examples share one private `@aml-jsx/examples` workspace. Group directories under `examples/src` organize related examples, and every example is one `.tsx` file whose filename is its CLI title. Its single default function returns a complete AML tree directly. Examples do not return wrapper descriptors, configure `AmlRuntime`, or own provider cleanup. An example that requires special evaluator behavior is demonstrating the runner rather than AML and must be redesigned.

`examples/run.ts` is the sole CLI orchestrator. It discovers example modules through a literal Vite glob, constructs `AmlRuntime` with the shared console tracer, evaluates the selected tree, and prints the final output. Agent providers release evaluation-owned resources through evaluation-scoped `finish` subscriptions. Run an example with `npm run example -- <title>`.

`examples/test/examples.test.ts` evaluates every deterministic example under `src/capabilities`, `src/core`, and `src/resources` and snapshots its final output under `examples/test/__snapshots__`. Credentialed model calls, Docker, filesystem-backed providers, and other environment-dependent proofs live under `src/integrations` and remain explicit commands rather than default tests.

The SDK package exports `.`, `./jsx-runtime`, `./jsx-dev-runtime`, and `./testing` exclusively from `dist/` and declares `"files": ["dist"]`. Build-only aliases let Vite and declaration generation consume private provider source, but the emitted JavaScript and declarations do not reference private workspace package names. The shared examples package imports only `@aml-jsx/sdk`. Its Turbo tasks depend on the SDK build, so a successful example run proves packaged output rather than an accidental application source alias.

SDK-owned TSX uses the private `#aml` package-import namespace with an `aml-source` condition during TypeScript analysis. Vite's SDK-local Oxc transform uses the same source runtime directly because its development dependency optimizer resolves injected automatic-runtime imports after normal alias resolution. Neither mechanism is visible to applications or examples, and the package-import defaults still point to the built runtime.

Slice 0 also verifies the resolved entry points are under the SDK's `dist` directory and runs a local `npm pack` inspection to prove the artifact contains its declared runtime and type files. This is a local packaging proof, not npm publication.

Focused behavior tests stay beside their owner. Conformance suites live in `@aml-jsx/sdk/testing`. Real Docker, network, credentials, and model calls remain explicit integration tests in the concrete provider package.

## Dependency strategy

### Workspace and bootstrap dependencies

- npm 11 for package management and workspace linking
- Turborepo for SDK build, test, typecheck, and explicitly ordered example tasks
- TypeScript with strict ESM settings for canonical type checking and SDK declaration emission
- Vite library mode for the `@aml-jsx/sdk` ESM build
- vite-node for running trusted TypeScript and JSX examples without building them
- Vitest for unit, conformance, and integration tests

The root pins the selected npm version through `packageManager`. Package scripts remain runnable through npm without requiring Turbo-specific runtime APIs.

`sdk/vite.config.ts` is the only Vite build configuration in Slice 0. Vite writes the SDK JavaScript and source maps to `dist` and bundles its source closure without requiring dependency builds. TypeScript emits declarations through `tsconfig.build.json`. The SDK's `package.json` declares its public exports explicitly. No root, example, application, or future provider package receives a build script until it needs to produce a distributable artifact.

### Boundary dependencies

- Standard Schema for validation contracts
- Standard JSON Schema for model-facing schema generation
- Zod 4 in tests and examples as the first concrete implementation
- the official MCP TypeScript SDK inside the OpenCode adapter for invocation-scoped JavaScript Tool transport
- `p-limit` when bounded Agent concurrency is implemented
- Execa only inside a provider that owns local process execution

`@aml-jsx/sdk` does not own an MCP client dependency. Agent adapter packages use their harness's native MCP support or own any MCP client library required to implement their adapter lifecycle.

### Platform APIs

- `async`/`await` for sequential evaluation
- `Promise.all()` for explicitly independent branches
- `AbortController` and `AbortSignal` for cancellation
- `try/finally` for cleanup
- native `fetch` for HTTP
- `node:path` and `realpath` for security-sensitive containment
- `crypto.randomUUID()` for execution identity
- strict `JSON.parse` followed by schema validation

Do not introduce Effect, a task-graph engine, a generic queue, a service locator, or a custom plugin container for ordinary async evaluation.

### Future CLI

The CLI is an application that consumes `@aml-jsx/sdk`; it does not define language semantics. It may use:

- vite-node to execute trusted `main.tsx`

`aml run main.tsx` must execute the same entry point that direct SDK consumers run. The CLI does not introduce an `.aml` file format or a second evaluator.

## Implementation roadmap

Each slice is separately reviewed. A slice may change this structure only after `SPEC.md` changes first and the new ownership is clearer.

The component sequence through MVP is fixed: `<Agent>` with its `<System>` message-channel descriptor → `<Tool>` → `<Skill>` → `<Sandbox>` → `<Workspace>`. System ships with Agent because it is part of constructing one Agent request rather than an independent execution boundary. Provider packages and runtime infrastructure may be proven between component slices, but no later component moves ahead of this order.

### Phase A — Evaluation foundation

#### Slice 0 — Monorepo and evaluation foundation

- create the npm workspace root and Turborepo task graph
- create `sdk` and its package exports
- configure `sdk/vite.config.ts` as the only formal build in Slice 0
- build the SDK's complete source import graph without intermediate workspace builds
- emit SDK declarations with TypeScript
- implement AML values and JSX construction
- support text, empty values, arrays, fragments, and async components
- concatenate nested arrays and Fragments without implicit separators
- await siblings deterministically from left to right while preserving ordinary semantics for already-started Promises
- invoke every component once per evaluated occurrence
- add `examples/src/core/basic.tsx` to the shared examples workspace, importing `@aml-jsx/sdk` from built exports and running through vite-node
- verify SDK entry-point resolution and local package contents

Proof: the SDK builds to `dist`; its package artifact contains the public runtime, production JSX, development JSX, and type entry points; and the unbuilt single-file example resolves an async component tree to one string through public `@aml-jsx/sdk` exports without source aliases or imports.

Status: Done on 2026-07-27. Singular review passes found and verified async cycle guards ending before promised descendants settled, VM stack overflow for deeply nested valid values, double PromiseLike accessor reads, synchronous custom-thenable invocation that differed from native `await`, a non-callable named Fragment export, SDK-owned TSX self-resolving through stale `dist`, reverse sibling reads in the first iterative evaluator, erased JSX prop types, incomplete TSX typecheck globs, and a package proof that could inspect stale output. The corrected implementation uses an explicit stack-safe cursor evaluator, callable Fragments, generic JSX construction, clean source-only SDK TSX resolution, a self-building package proof, twenty behavior tests, strict SDK and consumer type checking, and a dist-only vite-node example. The final review confirmation reported no actionable findings.

### Phase B — MVP components

#### Slice 1 — `<Agent>`, `<System>`, and provider authorship

- add the provider-neutral Agent contract
- add `defineAgentProvider()`
- add a deterministic Agent fixture and conformance suite under `@aml-jsx/sdk/testing`
- support an optional runtime-default provider and an optional per-Agent provider override
- enforce the documented `maxAgentCalls` default and zero-as-unlimited convention
- keep `model` and fixed `system` as explicit Agent props
- resolve provider selection and model defaults with documented precedence
- collect asynchronous System subtrees in authored order and join their resolved text with newline separators
- allow child Agent output to become a parent Agent system fragment
- resolve children before the parent Agent
- propagate provider failure with Agent identity
- add `examples/src/core/agent.tsx` to the shared examples workspace and import only built SDK exports

Proof: Agents using two deterministic provider instances run in one evaluation; a child Agent contributes generated system text to its parent; fixed and composed system fragments reach the provider in the required order; model overrides are preserved; the deterministic provider passes the public conformance suite; and the shared runner executes the example through built `@aml-jsx/sdk` and `@aml-jsx/sdk/testing` exports.

Status: Done on 2026-07-27. Singular review found and verified response accessors escaping Agent attribution, provider shapes accepted by the helper and conformance but rejected by the runtime, name normalization contradicting inferred literal types, missing Agent-call budgeting, copy-local primitive identity at both runtime and TypeScript boundaries, repeated provider-member capture, Agent behavior accumulating in the core evaluator, co-located independent public contracts, and one extracted file whose name did not match its primary export. The corrected implementation captures response text once, shares strict object-provider validation, rejects non-normalized names, captures each configured provider boundary once, enforces the default 32-call budget with zero as unlimited, uses a copy-stable structural runtime discriminant without accepting unbranded descriptors, keeps provider execution in `AgentExecutor`, gives public contracts matching files, and passes forty-one behavior tests plus clean installed-package and two-copy validation. Final reviewer confirmation reported no unresolved findings.

#### Slice 2 — OpenCode Agent package

- create the private OpenCode provider workspace and export `opencodeAgent()` from `@aml-jsx/sdk`
- implement its configured `opencodeAgent()` factory with `defineAgentProvider()`
- keep OpenCode sessions, credentials, and usage data inside the adapter
- expose a provider-neutral narrow session-client port for deterministic dependency injection without leaking OpenCode SDK types
- start an owned OpenCode server lazily and expose idempotent provider cleanup
- create one fresh OpenCode session per Agent request and propagate cancellation
- disable all OpenCode tools in the text-only slice and return only visible response text
- inject the OpenCode client boundary so deterministic tests never start a real server
- pass SDK conformance and opt-in credentialed integration tests

Proof: a packaged single-Agent example runs through OpenCode without importing provider source files.

This provider slice does not introduce a component and therefore does not interrupt the MVP component order. Later capability slices extend its conformance requirements.

Status: Done on 2026-07-27. Singular review found that cancellation existed below the public runtime boundary but could not be requested by an AML consumer, concurrent provider cleanup callers did not share one completion barrier, and several raw OpenCode response fields were read repeatedly or accepted with truthy rather than exact validated shapes. The corrected implementation adds caller-owned evaluation cancellation, shares one cleanup promise and failure across all `close()` callers, captures external values once, rejects malformed response metadata and cleanup acknowledgements, and documents OpenCode's unavoidable unacknowledged-session ambiguity during cancelled creation. Forced build and typecheck pass; forty-three SDK tests and fourteen deterministic OpenCode tests pass; both package checks and all deterministic examples pass; and a fresh credentialed `opencode-go/minimax-m3` example returned `AML_OPENCODE_OK`. Final correctness, maintainability, and skeptical review lanes reported no unresolved findings.

#### Slice 3 — `<Tool>` and `defineTool()`

- separate capability descriptors from prompt text
- generate model-facing input schemas
- validate JavaScript Tool input and output
- keep capabilities scoped to one Agent
- extend deterministic and OpenCode conformance for host and JavaScript Tools

Proof: an Agent calls one declared async function and cannot call an undeclared Tool.

Status: Done on 2026-07-27. The implementation adds exact Agent-local host and JavaScript Tool grants, runtime allowlists, Standard Schema input and optional output validation, Standard JSON Schema declarations, stack-safe immutable JSON snapshots, and an authenticated OpenCode MCP bridge. Singular review found malformed Standard Schema results reaching application code, structural and copied Tool definitions bypassing validation, generated input schemas reported as output errors, `__proto__` snapshot corruption, recursive snapshot stack overflow, OpenCode capability setup after session creation, missing injected-port validation, hidden setup-cleanup failures, persistent dynamic MCP registrations, and mixed or concurrent disposable-host port collisions. The corrected design uses a package-global exact-identity WeakMap with an SDK-owned execution port, preserves cross-copy Tool compatibility, translates boundary-neutral snapshot errors at their owner, preflights capabilities before creating sessions, runs JavaScript Tool sessions on disposable port-0 OpenCode hosts, and preserves multi-boundary cleanup causality. Fifty-four SDK tests and twenty-one deterministic OpenCode tests pass; both package checks include dist-only and cross-copy execution proof; and a fresh credentialed `opencode-go/minimax-m3` call returned `AML_OPENCODE_TOOL_OK`. Final correctness, maintainability, and skeptical review lanes reported no actionable findings.

#### Slice 4 — `<Skill>`

- support local file content, inline AML content, and their deterministic combination
- resolve relative paths from the runtime working directory
- decorate content with optional deterministic name and description metadata
- preserve cancellation and attribute local filesystem failures

Proof: local, inline, and generated Skill content contributes text in authored order; combined content follows the specified separator and metadata format; a missing local file rejects before the containing Agent executes.

Status: Done on 2026-07-27. The final Slice 4 deliberately supports only local files and inline AML, including deterministic file-plus-children composition and optional name/description labels. An overbuilt remote resolver, registry client, authentication path, downloader policy, cache, and public provenance surface were removed before release. Singular review then found that file reads occurred before inline child effects and that Skill behavior was accumulating in the core evaluator. The corrected implementation uses one internal `SkillEvaluator`, keeps `AmlRuntime` responsible only for scheduling and routing, and reads the local file in the completion frame after child AML resolves. Ten focused Skill tests cover local, inline, combined, labeled, System-routed, Agent-generated, reload, failure, validation, and in-flight cancellation behavior. Sixty-four SDK tests, twenty-one deterministic OpenCode tests, workspace type checking, SDK build, both package checks, the dist-backed Skill example, and diff validation pass. Final correctness, maintainability, and skeptical review lanes reported no actionable findings.

#### Slice 5 — `<Sandbox>` contract

- define the provider and opaque lease contracts
- add `defineSandboxProvider()`
- add deterministic Sandbox fixtures and conformance tests
- acquire before descendant evaluation
- release after success, failure, or cancellation
- enforce restrictive nesting and Agent-provider compatibility

Proof: a deterministic provider proves acquisition, restrictive nesting, failure cleanup, and one-release semantics.

Status: Done on 2026-07-27 and extended on 2026-07-29. The SDK exposes `defineSandboxProvider()`, restrictive same-lease nesting, Agent-local working directories, an explicit compatibility handshake, deterministic fixtures, and conformance lifecycle. Leases now also carry one intentionally narrow provider-neutral runtime: logical access/root/cwd metadata plus bounded literal `exec()`. Lifecycle authority remains private to AML. Files, images, snapshots, ports, and background processes are not portable runtime requirements.

#### Slice 6 — Docker Sandbox package

- create the private Docker provider workspace and export `dockerSandbox()` from `@aml-jsx/sdk`
- implement its configured `dockerSandbox()` factory with `defineSandboxProvider()`
- keep Docker dependencies and options inside the package
- pass SDK conformance and explicit real-daemon integration tests

Proof: Local and Docker implement the same runtime, and one unchanged credentialed Pi workflow reads and writes exact Workspace files through both.

Status: Redesigned on 2026-07-29. The earlier Dockerode adapter and its Dockerfile builder, generic hardening surface, filesystem emulation spike, and provider-specific Agent handle were intentionally removed. `dockerSandbox()` now accepts a named image, optional trusted `setup`, bounded output, and optional standalone Workspace path. It starts and removes one container through the local Docker CLI, bind-mounts the selected Workspace root, and maps the common runtime to literal `docker exec` calls. Image contents, Agent installation, versioning, networking, identity, and production isolation policy belong to the environment author. `localSandbox()` provides the same runtime through trusted host child processes and explicitly makes no isolation claim. Focused SDK, Local, Docker, and real-daemon tests pass, and the opt-in credentialed Pi smoke passes through both providers.

#### Slice 7 — `<Workspace>` contract

- define durable materialization and lease contracts
- add `defineWorkspaceProvider()`
- add deterministic Workspace fixtures and conformance tests
- acquire, materialize, save, and release
- attach multiple sequential Sandboxes
- reject conflicting writers deterministically

Proof: two disposable deterministic Sandboxes observe one durable working tree and final changes survive both.

Status: Done on 2026-07-27. The SDK now exposes the top-level `<Workspace>` primitive, `defineWorkspaceProvider()`, immutable materialization references, exclusive lease acquisition, save-after-success-or-failure semantics, and exactly-once release. One evaluation may declare one Workspace outside Agent, Sandbox, Skill, and nested Workspace scopes; sequential outer Sandboxes receive the same frozen materialization while lifecycle authority remains private to AML. The provider contract now requires an explicit cross-package `WorkspaceConflictError` for active-writer rejection rather than inferring serialization from Promise timing. Its conformance suite proves conflict discrimination, bounded rejection, late serialized cleanup, reacquisition, persistence, malformed leases, unrelated failures, and hostile accessors. Deterministic fixtures prove shared processing data, placement errors, cancellation before and during cleanup, partial-work persistence, multi-boundary failure causality, and writer-lock recovery. The Docker provider prefers an active Workspace over its standalone host fallback and rejects acquisition when neither exists; six real-daemon tests include active Workspace attachment. The dist-backed Workspace example runs two disposable Sandboxes over one materialization and produces `wroteobserved:shared finding`. Singular correctness, maintainability, and skeptical review lanes reported no actionable findings after the conflict, timeout, cancellation, cleanup, and package-export fixes. One hundred nine SDK tests, twenty-one OpenCode tests, fifteen deterministic Docker tests, six real Docker integration tests, all workspace type checks, all three dist/package checks, the built-package Workspace example, and diff validation pass.

#### Slice 8 — Local Workspace package

- create the private local Workspace provider and export `localWorkspace()` from `@aml-jsx/sdk`
- implement its configured `localWorkspace()` factory with `defineWorkspaceProvider()`
- pass SDK conformance and filesystem integration tests

Proof: a local Workspace survives multiple SDK evaluations without adding Node filesystem assumptions to the provider-neutral contract.

Status: Done on 2026-07-27. `@aml-jsx/workspace-local` now maps one configured existing directory to a lazy provider-neutral Workspace provider. Acquisition canonicalizes symlinks and obtains a zero-retry cross-process renewable lock through `proper-lockfile`; concurrent providers targeting the same physical directory reject with `WorkspaceConflictError`, and successful release permits reacquisition. The direct materialization persists ordinary filesystem writes across SDK evaluations, while `save()` acts as a lock-health barrier and cleanup reports compromise without leaking dependency lifecycle errors. Timing options are validated within `proper-lockfile` and Node timer bounds, cancellation before acquisition performs no I/O, and cancellation racing a successful lock uses the same attributed cleanup path as a live lease. Singular review found overclaimed exclusivity for renewable locks, raw compromised-release errors, mutable configuration rereads, missing cross-process proof, unbounded timer values, and a late-cancellation cleanup inconsistency. The corrected SPEC documents the lack of fencing and possible overlap after stale recovery. Twelve focused Local Workspace tests include real child-process contention through canonical and symlink paths, lifecycle fault injection, SDK conformance, and persistence. Package type checking, dist/package validation, the built-package example, full workspace validation, and diff validation pass. Final correctness, maintainability, and skeptical review lanes reported no actionable findings.

MVP is complete when Slice 8 passes. It contains exactly the five component boundaries selected for the first usable language surface plus the evaluation foundation and concrete OpenCode, Docker, and local Workspace proofs.

### Phase C — Post-MVP capabilities and orchestration

#### Slice 9 — `<Mcp>` and `defineMcpServer()`

- separate MCP server descriptors from prompt text
- support provider-native names and explicit `stdio` or Streamable HTTP descriptors
- keep MCP grants scoped to one Agent session
- add allowlist, lifecycle, redaction, and failure behavior
- extend deterministic and OpenCode conformance for attach and cleanup

Proof: a declared test MCP server is available for one Agent session, is absent from sibling Agents, and is disposed after success and failure. Slice 12 separately proves that the same attachment survives FollowUps.

Status: Done on 2026-07-27. The SDK now exposes Agent-scoped `<Mcp>` grants and exact-identity `defineMcpServer()` descriptors for provider-native names, local stdio servers, and remote Streamable HTTP servers. Definitions snapshot and freeze transport input, survive duplicate physical SDK copies through a weak realm registry, and never perform I/O themselves. Agent requests keep MCP configuration distinct from prompt text and reject misplaced, duplicate, and disallowed grants before provider execution. The OpenCode adapter attaches explicit JavaScript Tools and MCP servers to one disposable capability host, disconnects every acquired resource in reverse order, denies undeclared host capabilities, and fails closed on normalized namespaces that overlap declared servers, inherited servers, ambient host Tools, or exact Tool grants. Because OpenCode capability authorization depends on server wildcard and identifier behavior, capability-bearing calls preflight a healthy server and accept only the reviewed `1.18.4` and `1.18.5` compatibility boundary; the generated client is pinned separately at `1.18.5`. Singular review found stateful descriptor access, missing live MCP proof, wildcard namespace leaks, provider-normalization collisions, inherited namespace overlap, platform-equivalent permissions, and an unbounded executable-version assumption. The corrected implementation snapshots hostile input, checks every capability source before creating a session, canonicalizes OpenCode permission literals, and gates version-sensitive behavior before attaching resources. Eight SDK MCP tests, thirty-one OpenCode tests, one isolated built-package example, all workspace type checks, all four dist/package checks, and two credentialed live OpenCode-Go integrations for JavaScript Tool and configured MCP invocation pass. Final correctness and skeptical review lanes reported no actionable findings; the only maintainability hint was resolved by documenting the sanitizer's authorization role.

#### Slice 10 — `evaluate()` and structured results

- allow component-local awaited evaluation
- keep evaluation inside the current domain
- reject detached use after AML observes component completion, while joining same-turn asynchronous work that JavaScript schedules before the native Promise settlement reaction
- accept a Standard Schema and Standard JSON Schema compatible contract
- validate provider structured output and return typed data

Proof: valid Zod 4 output reaches its consumer, invalid output fails at the Agent boundary, and no component suspends or rerenders.

Status: Done on 2026-07-27. The SDK now exposes ordinary asynchronous component-local `evaluate()` for text and typed structured results without suspension or rerendering. Nested calls share one evaluation domain, including Agent-call and depth budgets, cancellation, trace allocation, active Sandbox and Workspace scopes, cross-copy component bindings, cycle ancestry, and cleanup barriers for concurrent work. Schema-bearing calls accept one combined Standard Schema and Standard JSON Schema contract, snapshot only portable draft 2020-12 JSON Schema for providers, require exactly one Agent and no adjacent result text, reject non-JSON provider values before application validation, and return Standard Schema transformations. The OpenCode adapter maps that contract to native `json_schema` output and grants its internal `StructuredOutput` Tool only after the same reviewed-version and ambient-collision preflight as every other capability. Singular review found missing JSON transport enforcement, a structured-only capability preflight bypass, cross-boundary cycle loss, synchronous and custom-thenable AsyncLocalStorage gaps, an inherited structured-result mismatch, and misplaced duplicate boundary contracts. The corrected implementation closes each boundary and gives `AmlJsonValue`, `AmlModelSchema`, and `AgentOutputRequest` independent owners. One hundred thirty-four SDK tests, thirty-seven OpenCode tests, all workspace type checks, all four dist/package checks, the dist-backed structured example, and three credentialed live OpenCode-Go integrations for JavaScript Tool, configured MCP, and structured output pass. Final correctness, architecture, and skeptical security review lanes reported no actionable findings.

#### Slice 11 — Bounded Agent concurrency

- add the Agent-call scheduler
- enforce configured concurrency with `p-limit`
- propagate active cancellation
- reject or cancel queued calls deterministically
- demonstrate explicit `Promise.all()` branches

Proof: two specialists run concurrently, feed one coordinator in declared result order, and never exceed the configured Agent-call limit.

Status: Done on 2026-07-27. Every root evaluation now owns one `AgentScheduler` backed by `p-limit` 7.3.1. `maxConcurrentAgents` defaults to four, zero remains unlimited, complete provider calls occupy slots until their session and capability cleanup settles, ready calls queue FIFO, separate roots remain independent, and ordinary JSX siblings remain serial unless application code explicitly starts branches with `Promise.all()`. Cancellation reaches active providers through the existing signal and clears queued calls with the caller's exact reason before provider code starts. Provider validation, compatibility checks, Promise assimilation, Tool chains, response accessors, and structured validation run without the component-local `evaluate()` capability, so unsupported provider-reentrant Agent execution rejects instead of injecting unauthored work or self-deadlocking a full semaphore. Singular review found Agent-call budget errors misattributed as provider failures, missing failed-slot and root-isolation proofs, and multiple re-entrant escapes through provider callbacks, custom thenables, response values, and provider accessors. The corrected boundaries preserve AML error ownership and mask every provider-owned execution path. One hundred forty-eight SDK tests, full workspace type checking, the SDK dist/package proof, and the dist-backed concurrency example pass; the example demonstrates two active specialists completing out of order while synthesis receives authored result order. Final correctness, architecture, and skeptical security review lanes reported no actionable findings.

#### Slice 12 — `<FollowUp>`

- build one static, flat same-session turn plan
- share Agent-wide Tool and MCP capabilities
- return only the final turn
- reject invalid nesting and placement

Proof: a deterministic session receives three turns in authored order while retaining one Tool and MCP capability set.

Status: Done on 2026-07-27. The SDK now exposes flat static `<FollowUp>` descriptors that resolve completely before their containing Agent opens one provider session. Components and Fragments may expand to sibling FollowUps, while nesting, empty turns, turn-specific Tool or MCP grants, non-whitespace trailing prompt text, placement outside Agent, and descriptors hidden beneath a lexical Sandbox fail before the parent provider runs. `maxTurnsPerAgent` defaults to sixteen authored inputs, zero is unlimited, and a multi-turn session still consumes one Agent-call reservation and one scheduler slot for its complete lifetime. `AgentRequest.followUps` is an optional frozen ordered plan, and the public provider conformance now exercises two turns. The OpenCode adapter attaches capabilities and creates a session once, sends every turn sequentially through that session, retains its system/model/Tool/MCP configuration, applies JSON Schema and the provider-owned `StructuredOutput` grant only to the final turn, returns only that final response, and stops later turns after failure or cancellation. It snapshots a fail-closed capability map and cleanup method immediately after attachment so hostile accessors cannot change grants between turns or strand live MCP and Tool resources. Singular review found an intervening Sandbox placement escape, an intermediate structured-output grant, and a post-attachment getter leak; the corrected boundaries have direct regression coverage. One hundred fifty-nine SDK tests, forty-four deterministic OpenCode tests, all eighteen workspace type-check targets, all four dist/package proofs, the dist-backed FollowUp example, and diff validation pass. One credentialed `opencode-go/minimax-m3` integration also proved that the real provider session retained a random token across the FollowUp boundary. Final correctness, architecture, and skeptical security review lanes reported no actionable findings.

#### Slice 13 — `<Loop>`

- validate immutable JSON state snapshots
- expose one staged state capability
- commit atomically after an Agent finishes
- enforce transition limits

Proof: committed state appears only in the next fresh Agent iteration.

Status: Done on 2026-07-27. The SDK now exposes `<Loop>` for fresh Agent sessions over immutable, schema-validated JSON state. Each iteration receives one deeply frozen snapshot and one expiring runtime-owned `aml_set_state` capability on only its selected outer Agent. Tool calls serialize in invocation order, validate complete patches atomically, reject unknown initial-state keys, remain staged through FollowUps, and cannot publish after the provider session ends. Changed state discards stale output, reserves one evaluation-wide transition, and starts a fresh session; stable state returns the current output. `maxStateTransitions` defaults to sixteen and zero is unlimited. Loop outer selection supports transparent asynchronous components, Fragments, arrays, Promises, component-local `evaluate()`, depth and cycle boundaries, and cancellation without running later wrappers. Standard Schema input and output remain distinct so self-normalizing defaults and transformations can normalize authored initial state before the first rendered snapshot. Schema-bearing `evaluate()` rejects Loops in prompt, System, Skill, and FollowUp channels so its exactly-one-Agent contract cannot be bypassed. Singular review found that structured-evaluation escape, missing selector cancellation parity, tuple widening in `DeepReadonly`, conflated and then over-broad schema input/output typing, an unused callback parameter, and stale tracker ownership. The corrected implementation has direct regressions for every code issue plus stable schema normalization and detached asynchronous Tool validation. One hundred eighty-one SDK tests, forty-four OpenCode tests, fifteen Docker Sandbox tests, twelve local Workspace tests, all seventeen workspace type-check targets, all four dist/package proofs, the dist-backed Loop example, and diff validation pass. Final intent, correctness, architecture, maintainability, security, and concurrency review lanes reported no actionable findings.

#### Slice 14 — Codex Agent package

- create the private Codex provider workspace and export `codexAgent()` from `@aml-jsx/sdk`
- implement its configured `codexAgent()` factory with `defineAgentProvider()`
- keep Codex sessions, tools, MCP servers, credentials, and usage data inside the adapter
- pass SDK conformance and opt-in credentialed integration tests

Proof: the same review example runs through Codex by changing injected provider construction only.

Status: Done on 2026-07-27. The private Codex provider workspace supplies the synchronous, side-effect-free `codexAgent()` factory exported by `@aml-jsx/sdk`. Each AML Agent receives one fresh read-only Codex thread; authored FollowUps resume that thread in order; `<Agent model>` takes precedence over provider defaults; host `read`, `grep`, and `glob` grants enable only Codex's read-only shell boundary; JavaScript Tools use an authenticated invocation-local multi-session MCP bridge; explicit and provider-native MCP grants remain attached for the complete thread; and strict structured output applies only to the final turn. The adapter intentionally inherits normal repository and user Codex configuration and does not claim an isolated capability profile or AML Sandbox compatibility.

Singular review found prototype-sensitive capability dictionaries, explicit `null` dependency injection falling through to the real credentialed SDK, stateful option getters bypassing validation, incomplete recursive JSON Schema normalization, sparse and excessively deep provider input failing late, misleading ambient MCP naming, malformed explicit named MCP configuration falling through to ambient authority, incomplete Tool shutdown draining, cancellation hidden by an injected result getter, an unnecessary bridge state field, export ownership drift, and a copied Tool echo that did not prove the stated provider-substitution workflow. The corrected implementation preserves hostile property names as ordinary data, captures every external option once, distinguishes absent, supplied, and opaque host MCP configuration, delegates only genuinely absent exact-name resolution to the real CLI, recursively closes standard schema containers, rejects malformed or excessively deep input synchronously, drains admitted Tool work before releasing the Agent boundary, and keeps internal bridge types private. `examples/src/integrations/review` owns one shared two-specialist parallel review and synthesis tree with deterministic, OpenCode, and Codex harnesses.

The first live parallel OpenCode review exposed two disposable hosts contending on OpenCode's ambient SQLite database. Package-owned OpenCode servers now use Execa to pass the documented process-private `OPENCODE_DB=:memory:` override directly to each child without mutating the caller environment. Deterministic launcher tests prove explicit environment ownership, complete-line readiness parsing, bounded lifecycle diagnostics, startup cleanup, and idempotent shutdown. The external execution gate reached its usage limit before a post-fix credentialed OpenCode rerun could be authorized; this does not weaken the Slice 14 Codex acceptance proof but remains explicit validation debt for the shared OpenCode harness.

Twenty deterministic Codex tests, fifty deterministic OpenCode tests, all workspace type checks, all five package proofs, the deterministic and credentialed Codex dist-backed review example, diff validation, and three credentialed `gpt-5.3-codex-spark` integrations for FollowUps, a JavaScript Tool, and structured output pass. Final correctness, hostile-boundary, and maintainability review lanes reported no actionable findings.

#### Slice 15 — Observability consumers

- stabilize provider-neutral trace events
- add console trace presentation
- defer OpenTelemetry to a consumer package until the stable event contract proves the dependency
- use one runtime-owned Hookable event layer for evaluation lifecycle and observability
- keep hooks scoped to one evaluation and prevent observers from mutating requests or results
- keep trace-sink failure reporting out of workflow semantics

Proof: one deterministic run and one live-provider run produce attributable spans without exposing prompt content by default.

Dependency decision: Hookable is the runtime's typed registration substrate. The runtime owns publication and exposes only `on()` and `once()` to providers and consumers. Each evaluation has a separate scoped registry. Start hooks use Hookable's fail-fast serial semantics; finish and trace use AML-specific callers because cleanup must preserve every failure and observers must not suppress one another. OpenTelemetry remains out: the stable event stream is the integration boundary, and an eventual exporter can live in its own optional package without adding telemetry dependencies to `@aml-jsx/sdk`.

Status: Done on 2026-07-27. Tracing and awaited evaluation cleanup now share one runtime-owned Hookable layer. `AmlRuntime` exposes `on()` and `once()`, provider contexts receive an independent evaluation-scoped subscriber, and OpenCode closes its evaluation host through `events.once("finish")` without extending the Agent provider contract. Trace content consent is captured per listener; one observer cannot expose sensitive fields to another or suppress later observers by throwing. The example runner attaches the console tracer through `runtime.on("trace")`. Splitting request planning, response resolution, and Tool instrumentation reduced `AgentExecutor` from 556 lines to 208. The SDK exports `createAgentExecutionContext()` from `@aml-jsx/sdk/testing` so adapter and conformance tests share the portable context fixture rather than duplicating no-op event subscribers.

Repository tooling now keeps the SDK build bespoke while the four single-entry provider packages share `config/create-vite-library-config.ts`. Turbo discovers each package's `package:check` task and builds its dependency graph before checking distributable output, avoiding a root script that manually names every provider. The OpenCode adapter keeps session lifecycle and execution together while its substantial external-option capture boundary lives in `opencode-agent-options.ts`.

The remaining package-verification cleanup is deliberate rather than additive: before expanding the provider catalog, compare the generic checks in each `scripts/check-package.ts` with Publint and remove duplicated code only if the external checker can replace it. AML-specific assertions such as exact published files and provider runtime conformance remain repository-owned.

Two hundred twenty-five SDK tests, all adapter and resource-provider tests, every workspace type check and build, all five distributable package checks, and the dist-backed basic and review examples pass after this cleanup.

Singular review found component authority escaping through custom thenables, flattened lexical hierarchy, console-writer rejection leaks, split Agent span ownership and identity, provider cancellation replacement, missing MCP provenance, untraced Agent and Tool preflight failures, and content tracing that could change stateful Tool input. The corrected design gives each span one runtime owner and one canonical identity, preserves provider signals, snapshots transport input independently of tracing, and reports observer failures only out of band. One hundred ninety-nine SDK tests, fifty OpenCode tests, twenty Codex tests, fifteen Docker tests, twelve Local Workspace tests, all workspace type checks and builds, SDK package validation, the dist-backed deterministic example, and a credentialed `gpt-5.3-codex-spark` observability run pass. Final correctness, skeptical intent, and maintainability review lanes reported no actionable findings.

### Phase D — Late dependency scope

#### Slice 16 — Context

- provide immutable downward-scoped dependencies
- support nested shadowing
- isolate concurrent branches
- provide no mutation or rerender semantics

Proof: a session repository is captured by a Tool without entering prompt text.

Status: Done on 2026-07-27. `createContext()` now defines an exact-identity required or explicitly defaulted dependency, `<Context.Provider>` transparently creates one persistent lexical binding, and synchronous `useContext()` reads that binding only during an active ordinary component invocation. Nested Providers shadow only their subtree; component-local `evaluate()`, structured Agent selection, Loop outer-Agent selection, concurrent branches, concurrent root evaluations, and compatible physical SDK copies preserve the correct immutable scope. Values are retained by identity without evaluation, cloning, freezing, prompt insertion, or trace serialization. Provider callbacks and detached component work cannot retain ambient Context authority.

The deterministic proof captures a session repository in a JavaScript Tool closure and verifies that neither the repository nor its private data enters Agent prompt or trace content. Singular review found duplicated Provider validation and a stateful-accessor ordering regression introduced while centralizing it. The corrected `ContextRegistry.captureProvider()` owns exact registration, missing-value validation, and one-time value-before-children capture for both evaluator paths. Two hundred fourteen SDK tests, all workspace type checks, all package builds and tests, SDK package and cross-copy validation, the dist-backed Context example, and diff validation pass. Final correctness, skeptical intent, and maintainability review lanes reported no actionable findings.

#### Slice 17 — Pi Agent package

- create the private Pi provider workspace and export `piAgent()` from `@aml-jsx/sdk`
- embed `@earendil-works/pi-coding-agent` without requiring a global Pi installation
- support provider/model selection, exact host and JavaScript Tool grants, FollowUps, cancellation, and structured JSON validation
- keep unsupported MCP behavior explicit and prove the fresh-user credential path with OpenCode Go

Proof: a deterministic conformance suite and a credentialed OpenCode Go run exercise conversation history, a process-local JavaScript Tool, and schema-validated structured output through Pi.

Status: Done on 2026-07-29. The adapter constructs one isolated in-memory Pi SDK session per AML Agent, disables ambient Pi extensions and project resources, maps only declared host and JavaScript Tools, executes FollowUps in the retained session, aborts with the AML signal, and disposes the session on every settled path. `provider/model` identities map through Pi's `ModelRuntime`; explicit keys remain runtime-only while normal provider environment variables remain available. Pi lacks a compatible MCP attachment API and native turn-level JSON Schema output, so the adapter rejects MCP grants before construction and uses schema-guided JSON text plus AML's authoritative Standard Schema validation.

The public factory boundary now preserves vendor-native configuration rather than inventing an AML provider schema: Pi accepts its exported `ProviderConfig` entries through `providers`, and OpenCode accepts its SDK `Config` through `config`. Explicit keys, custom endpoints, headers, and model catalogs therefore work without requiring either local profile, while ambient credential discovery remains available.

The fresh-user benchmark required no global Pi install or Pi configuration. Installing the SDK package was sufficient. An existing `OPENCODE_API_KEY` authenticated Pi's built-in `opencode-go` provider. The first MiniMax-M3 Tool test fabricated a result rather than calling the granted Tool; the same adapter passed with GLM-5.1 after registering Pi's explicit custom-Tool prompt snippet. Three credentialed GLM-5.1 integrations for FollowUps, a JavaScript Tool, and structured JSON output pass alongside deterministic adapter tests and package conformance. The published Pi package also installs a shrinkwrapped `brace-expansion@5.0.7` through `minimatch`; npm reports its unbounded-expansion denial-of-service advisory and does not honor a consumer override inside that shrinkwrapped subtree, so this remains explicit upstream dependency debt.

#### Slice 18 — Daytona Sandbox package

- create the private Daytona provider workspace and export `daytonaSandbox()` from `@aml-jsx/sdk`
- preserve Daytona-native client configuration and image-or-snapshot creation parameters
- transfer one active Workspace before execution and reconcile writable changes before release
- map the narrow runtime to bounded Daytona command execution without exposing a generic filesystem API
- pass focused lifecycle tests and one credentialed real-Agent smoke

Proof: the unchanged Pi file workflow runs through Daytona with explicit API-key configuration, reads the uploaded Workspace, writes an exact result remotely, and a second fresh Daytona Sandbox reads the reconciled result.

Status: Done on 2026-07-29. The adapter lazily constructs Daytona's SDK client, creates one disposable image or snapshot, archives the selected local Workspace root into the remote user's writable `workspace` directory, runs optional trusted `setup`, and maps literal command arguments, logical cwd, environment, timeout, cancellation, and bounded output through the narrow runtime. Writable release mirrors the complete remote tree back, including deletions, before deleting the Sandbox. Read-only execution is rejected because archive transfer cannot enforce a read-only guest tree. Focused tests prove native create parameters, hydration, command mapping, reconciliation, deletion, and configuration validation. A credentialed Daytona smoke using the same real Pi/OpenCode Go workflow as Local and Docker passed against the live service, then a second fresh Daytona Sandbox and Pi session read the reconciled file.

Claude, Cloudflare, S3, the CLI, and the website receive separate slices only when their requirements are approved. Their target directories document intended ownership, not committed implementation.

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
- every implementation file has one primary export matching its filename
- provider packages pass their SDK conformance suite
- examples consume package exports from `dist`
- the resulting public API is reviewed before the next slice starts
- exported boundaries, non-obvious functions, and meaningful branch decisions satisfy the comment contract in the file and export rules

## Immediate implementation boundary

Slices 0 through 18 are complete. The narrow common Sandbox runtime now has Local, image-only Docker, and Daytona proofs. The next approved investigation is the Agent-process bridge for Codex and OpenCode; Modal and Cloudflare remain portability checks until their implementation work is approved. S3-compatible, Git, and Durable Object Workspaces remain later work.

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
- website
- generic plugin infrastructure
- npm publication

Deferred ideas may enter the roadmap only after their behavior is accepted in `SPEC.md`.

## Working questions

These remain product questions until resolved into `SPEC.md`:

- When, if ever, should JSX siblings become implicitly concurrent?
- Which trace events are stable public API?
- What is the first useful artifact contract for large data?
- Where should retries and schema repair live?
- What additional runtime capability is first proven necessary by Codex, OpenCode, or Daytona?
- Which Workspace backend proves the abstraction beyond local disk?
- What should an Agent provider expose about inherited host configuration?
- Should a strict capability mode reject provider-inherited MCP servers that cannot be disabled?
- Should an explicit `stdio` MCP descriptor choose its execution location, or should that remain entirely adapter-owned?
- When does the CLI become more valuable than direct SDK execution?
- When, if ever, is an all-providers convenience package worth its dependency cost?

## Idea parking lot

- human approval gates
- durable execution and resume
- richer cancellation and retry policies
- trace timeline or Gantt visualization
- interactive Agent TUI
- remote Sandbox fleets
- object-storage Workspace snapshots
- Agent-as-Tool with explicit resource and budget semantics

Items in this section are not commitments and must not shape implementation until promoted into `SPEC.md` and the delivery roadmap in this document.

## Dependency references

- [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces)
- [Turborepo](https://turborepo.com/docs)
- [Vite library mode](https://vite.dev/guide/build.html#library-mode)
- [Vitest](https://vitest.dev/guide/)
- [Standard Schema](https://standardschema.dev/schema)
- [Standard JSON Schema](https://standardschema.dev/json-schema)
- [p-limit](https://github.com/sindresorhus/p-limit)
- [Execa](https://github.com/sindresorhus/execa)
- [Hookable](https://github.com/unjs/hookable)
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [vite-node](https://github.com/antfu-collective/vite-node)
