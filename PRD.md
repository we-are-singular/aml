# Agent Markup Language product requirements and delivery plan

Status: Phase 1 — Slices 0–1 done; Slice 2 pending

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

The SDK owns small provider contracts, typed definition helpers, and conformance suites. Concrete Agent, Sandbox, and Workspace adapters are independently installable packages that use the same public authoring surface available to third parties. Applications install only the providers they use.

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
- a third party can author and test a provider without modifying `@aml/sdk`
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

| Work | Scope | Status |
| --- | --- | --- |
| Phase 0 | Proof of concept preserved under `poc/` | Done and archived |
| Slice 0 | Monorepo and evaluation foundation | Done |
| Slice 1 | `<Agent>`, `<System>`, and provider authorship | Done |
| Slice 2 | OpenCode Agent package | Pending |
| Slice 3 | `<Tool>` and `defineTool()` | Pending |
| Slice 4 | `<Skill>` | Pending |
| Slice 5 | `<Sandbox>` contract | Pending |
| Slice 6 | Docker Sandbox package | Pending |
| Slice 7 | `<Workspace>` contract | Pending |
| Slice 8 | Local Workspace package and MVP completion | Pending |
| Slice 9 | `<Mcp>` and `defineMcpServer()` | Pending |
| Slice 10 | `evaluate()` and structured results | Pending |
| Slice 11 | Bounded Agent concurrency | Pending |
| Slice 12 | `<FollowUp>` | Pending |
| Slice 13 | `<Loop>` | Pending |
| Slice 14 | Codex Agent package | Pending |
| Slice 15 | Observability consumers | Pending |
| Slice 16 | Context | Pending |

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
│   └── website/
├── examples/
│   ├── basic/
│   ├── parallel-agents/
│   └── review/
├── packages/
│   ├── sdk/
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
  "workspaces": ["apps/*", "examples/*", "packages/sdk", "packages/*/*"]
}
```

The root owns orchestration scripts and shared development policy. It does not publish runtime code.

Slice 0 has one formal build target: `@aml/sdk`. The SDK owns `packages/sdk/vite.config.ts`, and its Vite build follows the SDK's complete source import graph, including neutral workspace source outside `packages/sdk` when such a boundary eventually exists. Workspace dependencies do not need intermediate builds or `dist` directories. The SDK must not import or bundle concrete providers.

Turborepo runs the SDK build before the built-package example, but there is no recursive `^build` chain. Examples and applications do not gain build pipelines merely to participate in the workspace. A future independently distributed provider may own its own leaf build when its implementation slice requires an artifact; that build compiles its source closure directly and treats `@aml/sdk` as an external public dependency rather than depending on an SDK build task.

### Package identities

| Directory | Package | Responsibility |
| --- | --- | --- |
| `packages/sdk` | `@aml/sdk` | JSX runtime, evaluator, primitives, provider contracts, definition helpers, and conformance utilities |
| `packages/agents/opencode` | `@aml/agent-opencode` | OpenCode Agent adapter and OpenCode-specific options |
| `packages/agents/codex` | `@aml/agent-codex` | Codex Agent adapter and Codex-specific options |
| `packages/agents/claude` | `@aml/agent-claude` | Claude Agent adapter and Claude-specific options |
| `packages/sandboxes/local` | `@aml/sandbox-local` | Local-process Sandbox adapter |
| `packages/sandboxes/docker` | `@aml/sandbox-docker` | Docker Sandbox adapter |
| `packages/sandboxes/daytona` | `@aml/sandbox-daytona` | Daytona Sandbox adapter |
| `packages/sandboxes/cloudflare` | `@aml/sandbox-cloudflare` | Cloudflare Sandbox adapter |
| `packages/workspaces/local` | `@aml/workspace-local` | Local durable Workspace adapter |
| `packages/workspaces/s3` | `@aml/workspace-s3` | S3-compatible Workspace adapter |

npm package names permit one scope and one package segment. `@aml/agents/opencode` would be a subpath export of one installed `@aml/agents` package, not an independently installable provider. Separate packages use names such as `@aml/agent-opencode`, allowing consumers to install and bundle only selected adapters.

An optional `@aml/agents` convenience package may be evaluated later. It would depend on and re-export every included Agent adapter, so it is not the default and must not be created until that installation tradeoff is intentional.

### Dependency direction

The dependency graph points inward:

```text
apps and examples
        │
        ├──────────────► concrete provider packages
        │                          │
        └──────────────────────────┤
                                   ▼
                               @aml/sdk
```

`@aml/sdk` defines provider-neutral contracts and never imports a concrete provider or vendor SDK. Each provider package depends on `@aml/sdk` and its own vendor dependencies. Provider packages do not depend on sibling providers unless a future integration has a real cross-provider contract.

Importing `@aml/sdk` must not install, initialize, import, or require OpenCode, Codex, Claude, Docker, Daytona, Cloudflare, S3, or another optional integration.

### SDK source layout

`packages/sdk` uses one domain-first source tree:

```text
packages/sdk/
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
│   │   │   └── skill-resolver.ts
│   │   ├── context/
│   │   │   ├── create-context.ts
│   │   │   └── use-context.ts
│   │   ├── loop/
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

`observability/` owns provider-neutral trace contracts. Concrete console and OpenTelemetry consumers may move to focused packages if their dependencies justify it.

`testing/` is exported as `@aml/sdk/testing`. It provides deterministic fixtures and reusable conformance suites without adding production-provider dependencies to the SDK.

There is deliberately no `lib/`, `utils/`, or global `types.ts` namespace. JSON parsing belongs at the schema boundary using it. RPC belongs to the provider using that transport. Console presentation belongs to observability. String logic remains local until a shared domain concept appears.

### Provider package layout

Every concrete adapter is a self-contained package:

```text
packages/agents/opencode/
├── package.json
├── tsconfig.build.json
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── index.ts
│   ├── opencode-agent.ts
│   └── opencode-session.ts
└── tests/
    ├── opencode-agent.test.ts
    └── opencode-agent.integration.test.ts
```

Its public factory owns provider-specific configuration:

```ts
export function opencodeAgent(options: OpenCodeAgentOptions): AgentProvider {
  return defineAgentProvider({
    name: "opencode",
    async run(request, context) {
      return runOpenCode(options, request, context);
    },
  });
}
```

The factory is synchronous and side-effect-free. It captures configuration and returns an immutable adapter. Client creation, credentials, network calls, processes, and leases occur only in the lifecycle method that needs them.

Every official provider package uses the same public `defineAgentProvider()`, `defineSandboxProvider()`, or `defineWorkspaceProvider()` helper available to third-party authors. Provider names must already be non-empty and trimmed; definition helpers validate rather than rewrite inferred identity values. The package must pass the corresponding suite from `@aml/sdk/testing`.

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

| File                       | Primary export        |
| -------------------------- | --------------------- |
| `aml-runtime.ts`           | `AmlRuntime`          |
| `evaluation-context.ts`    | `EvaluationContext`   |
| `trace-identity.ts`        | `AmlTraceIdentity`    |
| `agent.tsx`                | `Agent`               |
| `agent-execution-context.ts` | `AgentExecutionContext` |
| `agent-provider.ts`        | `AgentProvider`       |
| `agent-request.ts`         | `AgentRequest`        |
| `agent-response.ts`        | `AgentResponse`       |
| `define-agent-provider.ts` | `defineAgentProvider` |
| `agent-executor.ts`        | `AgentExecutor`       |
| `validate-agent-provider.ts` | `validateAgentProvider` |
| `system.tsx`               | `System`              |
| `define-tool.ts`           | `defineTool`          |
| `define-mcp-server.ts`     | `defineMcpServer`     |
| `docker-sandbox.ts`        | `dockerSandbox`       |
| `local-workspace.ts`       | `localWorkspace`      |
| `opencode-agent.ts`        | `opencodeAgent`       |
| `trace-sink.ts`            | `TraceSink`           |

Private helpers and private types stay in the owning file. A supporting export gets its own file only when another module consumes it as an independent contract.

Exceptions:

- `index.ts` is the reviewed public export manifest for one package.
- `testing.ts` is the reviewed `@aml/sdk/testing` public subpath manifest.
- `jsx-dev-runtime.ts` exposes the development functions required by TypeScript and Vite's automatic JSX runtime contract.
- `jsx-runtime.ts` exposes the functions required by TypeScript's automatic JSX runtime contract.
- a schema may export its inferred type when the schema is the canonical contract source.

Use kebab-case filenames. Avoid internal barrels. A package's root `index.ts` may expose its intentionally small public surface.

### Examples and built-package proof

Every example is a private npm workspace with explicit dependencies. A provider-backed example may declare:

```json
{
  "private": true,
  "dependencies": {
    "@aml/agent-opencode": "*",
    "@aml/sdk": "*"
  }
}
```

`examples/basic` declares only `@aml/sdk`.

The SDK package exports `.`, `./jsx-runtime`, and `./jsx-dev-runtime` exclusively from `dist/`, declares `"files": ["dist"]`, and has no TypeScript path alias that can redirect `@aml/sdk` to source. Examples import only the public package name. Their `vite-node` task depends explicitly on `@aml/sdk#build`, so a successful example run proves packaged output rather than an accidental source-only setup while the example itself remains unbuilt.

SDK-owned TSX uses the private `#aml` package-import namespace with an `aml-source` condition during TypeScript analysis. Vite's SDK-local Oxc transform uses the same source runtime directly because its development dependency optimizer resolves injected automatic-runtime imports after normal alias resolution. Neither mechanism is visible to applications or examples, and the package-import defaults still point to the built runtime.

Slice 0 also verifies the resolved entry points are under the SDK's `dist` directory and runs a local `npm pack` inspection to prove the artifact contains its declared runtime and type files. This is a local packaging proof, not npm publication.

Focused behavior tests stay beside their owner. Conformance suites live in `@aml/sdk/testing`. Real Docker, network, credentials, and model calls remain explicit integration tests in the concrete provider package.

## Dependency strategy

### Workspace and bootstrap dependencies

- npm 11 for package management and workspace linking
- Turborepo for SDK build, test, typecheck, and explicitly ordered example tasks
- TypeScript with strict ESM settings for canonical type checking and SDK declaration emission
- Vite library mode for the `@aml/sdk` ESM build
- vite-node for running trusted TypeScript and JSX examples without building them
- Vitest for unit, conformance, and integration tests

The root pins the selected npm version through `packageManager`. Package scripts remain runnable through npm without requiring Turbo-specific runtime APIs.

`packages/sdk/vite.config.ts` is the only Vite build configuration in Slice 0. Vite writes the SDK JavaScript and source maps to `dist` and bundles its source closure without requiring dependency builds. TypeScript emits declarations through `tsconfig.build.json`. The SDK's `package.json` declares its public exports explicitly. No root, example, application, or future provider package receives a build script until it needs to produce a distributable artifact.

### Boundary dependencies

- Standard Schema for validation contracts
- Standard JSON Schema for model-facing schema generation
- Zod 4 in tests and examples as the first concrete implementation
- `p-limit` when bounded Agent concurrency is implemented
- Execa only inside a provider that owns local process execution

`@aml/sdk` does not own an MCP client dependency. Agent adapter packages use their harness's native MCP support or own any MCP client library required to implement their adapter lifecycle.

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

The CLI is an application that consumes `@aml/sdk`; it does not define language semantics. It may use:

- vite-node to execute trusted `main.tsx`

`aml run main.tsx` must execute the same entry point that direct SDK consumers run. The CLI does not introduce an `.aml` file format or a second evaluator.

## Implementation roadmap

Each slice is separately reviewed. A slice may change this structure only after `SPEC.md` changes first and the new ownership is clearer.

The component sequence through MVP is fixed: `<Agent>` with its `<System>` message-channel descriptor → `<Tool>` → `<Skill>` → `<Sandbox>` → `<Workspace>`. System ships with Agent because it is part of constructing one Agent request rather than an independent execution boundary. Provider packages and runtime infrastructure may be proven between component slices, but no later component moves ahead of this order.

### Phase A — Evaluation foundation

#### Slice 0 — Monorepo and evaluation foundation

- create the npm workspace root and Turborepo task graph
- create `packages/sdk` and its package exports
- configure `packages/sdk/vite.config.ts` as the only formal build in Slice 0
- build the SDK's complete source import graph without intermediate workspace builds
- emit SDK declarations with TypeScript
- implement AML values and JSX construction
- support text, empty values, arrays, fragments, and async components
- concatenate nested arrays and Fragments without implicit separators
- await siblings deterministically from left to right while preserving ordinary semantics for already-started Promises
- invoke every component once per evaluated occurrence
- add `examples/basic` as a private workspace importing `@aml/sdk` from built exports and running through vite-node
- verify SDK entry-point resolution and local package contents

Proof: the SDK builds to `dist`; its package artifact contains the public runtime, production JSX, development JSX, and type entry points; and the unbuilt isolated example resolves an async component tree to one string through public `@aml/sdk` exports without source aliases or imports.

Status: Done on 2026-07-27. Singular review passes found and verified async cycle guards ending before promised descendants settled, VM stack overflow for deeply nested valid values, double PromiseLike accessor reads, synchronous custom-thenable invocation that differed from native `await`, a non-callable named Fragment export, SDK-owned TSX self-resolving through stale `dist`, reverse sibling reads in the first iterative evaluator, erased JSX prop types, incomplete TSX typecheck globs, and a package proof that could inspect stale output. The corrected implementation uses an explicit stack-safe cursor evaluator, callable Fragments, generic JSX construction, clean source-only SDK TSX resolution, a self-building package proof, twenty behavior tests, strict SDK and consumer type checking, and a dist-only vite-node example. The final review confirmation reported no actionable findings.

### Phase B — MVP components

#### Slice 1 — `<Agent>`, `<System>`, and provider authorship

- add the provider-neutral Agent contract
- add `defineAgentProvider()`
- add a deterministic Agent fixture and conformance suite under `@aml/sdk/testing`
- support an optional runtime-default provider and an optional per-Agent provider override
- enforce the documented `maxAgentCalls` default and zero-as-unlimited convention
- keep `model` and fixed `system` as explicit Agent props
- resolve provider selection and model defaults with documented precedence
- collect asynchronous System subtrees in authored order and join their resolved text with newline separators
- allow child Agent output to become a parent Agent system fragment
- resolve children before the parent Agent
- propagate provider failure with Agent identity
- add an isolated `examples/agent` proof that imports only built SDK exports

Proof: Agents using two deterministic provider instances run in one evaluation; a child Agent contributes generated system text to its parent; fixed and composed system fragments reach the provider in the required order; model overrides are preserved; the deterministic provider passes the public conformance suite; and the isolated example executes through built `@aml/sdk` and `@aml/sdk/testing` exports.

Status: Done on 2026-07-27. Singular review found and verified response accessors escaping Agent attribution, provider shapes accepted by the helper and conformance but rejected by the runtime, name normalization contradicting inferred literal types, missing Agent-call budgeting, copy-local primitive identity at both runtime and TypeScript boundaries, repeated provider-member capture, Agent behavior accumulating in the core evaluator, co-located independent public contracts, and one extracted file whose name did not match its primary export. The corrected implementation captures response text once, shares strict object-provider validation, rejects non-normalized names, captures each configured provider boundary once, enforces the default 32-call budget with zero as unlimited, uses a copy-stable structural runtime discriminant without accepting unbranded descriptors, keeps provider execution in `AgentExecutor`, gives public contracts matching files, and passes forty-one behavior tests plus clean installed-package and two-copy validation. Final reviewer confirmation reported no unresolved findings.

#### Slice 2 — OpenCode Agent package

- create `@aml/agent-opencode`
- implement its configured `opencodeAgent()` factory with `defineAgentProvider()`
- keep OpenCode sessions, credentials, and usage data inside the adapter
- create one fresh OpenCode session per Agent request and propagate cancellation
- inject the OpenCode client boundary so deterministic tests never start a real server
- pass SDK conformance and opt-in credentialed integration tests

Proof: a packaged single-Agent example runs through OpenCode without importing provider source files.

This provider slice does not introduce a component and therefore does not interrupt the MVP component order. Later capability slices extend its conformance requirements.

#### Slice 3 — `<Tool>` and `defineTool()`

- separate capability descriptors from prompt text
- generate model-facing input schemas
- validate JavaScript Tool input and output
- keep capabilities scoped to one Agent
- extend deterministic and OpenCode conformance for host and JavaScript Tools

Proof: an Agent calls one declared async function and cannot call an undeclared Tool.

#### Slice 4 — `<Skill>`

- support inline and resolved text
- implement deterministic locator precedence
- record provenance and trust metadata
- fail closed for unknown locators

Proof: a valid local Skill contributes text and a typo rejects.

#### Slice 5 — `<Sandbox>` contract

- define the provider and opaque lease contracts
- add `defineSandboxProvider()`
- add deterministic Sandbox fixtures and conformance tests
- acquire before descendant evaluation
- release after success or failure
- enforce restrictive nesting and Agent-provider compatibility

Proof: a deterministic provider proves acquisition, restrictive nesting, failure cleanup, and one-release semantics.

#### Slice 6 — Docker Sandbox package

- create `@aml/sandbox-docker`
- implement its configured `dockerSandbox()` factory with `defineSandboxProvider()`
- keep Docker dependencies and options inside the package
- pass SDK conformance and explicit real-daemon integration tests

Proof: the Docker package proves read-only and read-write confinement, cleanup, and packaged installation without adding Docker dependencies to `@aml/sdk`.

#### Slice 7 — `<Workspace>` contract

- define durable materialization and lease contracts
- add `defineWorkspaceProvider()`
- add deterministic Workspace fixtures and conformance tests
- acquire, materialize, save, and release
- attach multiple sequential Sandboxes
- serialize or reject conflicting writers

Proof: two disposable deterministic Sandboxes observe one durable working tree and final changes survive both.

#### Slice 8 — Local Workspace package

- create `@aml/workspace-local`
- implement its configured `localWorkspace()` factory with `defineWorkspaceProvider()`
- pass SDK conformance and filesystem integration tests

Proof: a local Workspace survives multiple SDK evaluations without adding Node filesystem assumptions to the provider-neutral contract.

MVP is complete when Slice 8 passes. It contains exactly the five component boundaries selected for the first usable language surface plus the evaluation foundation and concrete OpenCode, Docker, and local Workspace proofs.

### Phase C — Post-MVP capabilities and orchestration

#### Slice 9 — `<Mcp>` and `defineMcpServer()`

- separate MCP server descriptors from prompt text
- support provider-native names and explicit `stdio` or Streamable HTTP descriptors
- keep MCP grants scoped to one Agent session
- add allowlist, lifecycle, redaction, and failure behavior
- extend deterministic and OpenCode conformance for attach and cleanup

Proof: a declared test MCP server is available for one Agent session, survives its turns, is absent from sibling Agents, and is disposed after success and failure.

#### Slice 10 — `evaluate()` and structured results

- allow component-local awaited evaluation
- keep evaluation inside the current domain
- reject detached use after component completion
- accept a Standard Schema and Standard JSON Schema compatible contract
- validate provider structured output and return typed data

Proof: valid Zod 4 output reaches its consumer, invalid output fails at the Agent boundary, and no component suspends or rerenders.

#### Slice 11 — Bounded Agent concurrency

- add the Agent-call scheduler
- enforce configured concurrency with `p-limit`
- propagate active cancellation
- reject or cancel queued calls deterministically
- demonstrate explicit `Promise.all()` branches

Proof: two specialists run concurrently, feed one coordinator in declared result order, and never exceed the configured Agent-call limit.

#### Slice 12 — `<FollowUp>`

- build one static, flat same-session turn plan
- share Agent-wide Tool and MCP capabilities
- return only the final turn
- reject invalid nesting and placement

Proof: a deterministic session receives three turns in authored order while retaining one capability set.

#### Slice 13 — `<Loop>`

- validate immutable JSON state snapshots
- expose one staged state capability
- commit atomically after an Agent finishes
- enforce transition limits

Proof: committed state appears only in the next fresh Agent iteration.

#### Slice 14 — Codex Agent package

- create `@aml/agent-codex`
- implement its configured `codexAgent()` factory with `defineAgentProvider()`
- keep Codex sessions, tools, MCP servers, credentials, and usage data inside the adapter
- pass SDK conformance and opt-in credentialed integration tests

Proof: the same review example runs through Codex by changing injected provider construction only.

#### Slice 15 — Observability consumers

- stabilize provider-neutral trace events
- add console trace presentation
- evaluate whether OpenTelemetry deserves its own package
- evaluate Hookable as an internal typed lifecycle-event dispatcher for trace consumers, span setup, inspection, and extraction
- keep hooks scoped to one evaluation and prevent observers from mutating requests or results
- keep trace-sink failure reporting out of workflow semantics

Proof: one deterministic run and one live-provider run produce attributable spans without exposing prompt content by default.

### Phase D — Late dependency scope

#### Slice 16 — Context

- provide immutable downward-scoped dependencies
- support nested shadowing
- isolate concurrent branches
- provide no mutation or rerender semantics

Proof: a session repository is captured by a Tool without entering prompt text.

Claude, Daytona, Cloudflare, S3, the CLI, and the website receive separate slices only when their requirements are approved. Their target directories document intended ownership, not committed implementation.

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

## Immediate approval boundary

Slices 0 and 1 are complete. The next implementation approval authorizes Slice 2 only:

1. create the independently installable `@aml/agent-opencode` package
2. implement its configured provider factory with `defineAgentProvider()`
3. keep OpenCode SDK types, sessions, credentials, and usage handling inside the adapter
4. pass the public Agent-provider conformance suite with deterministic dependencies
5. add one opt-in credentialed integration proof and one built-package example

No Tool, Skill, Sandbox, Workspace, MCP, structured output, FollowUp, Loop, CLI, website, Codex provider, or unrelated primitive belongs in Slice 2.

## Explicitly deferred

- model-produced AML execution
- Agent-as-Tool
- `defineAgent()` until it has semantics beyond a function component
- generic `defineProvider()` and provider registries
- convenience aggregator packages such as `@aml/agents`
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
- Should observability hooks be synchronous, awaited and isolated, or buffered behind a flush boundary?
- What is the first useful artifact contract for large data?
- Where should retries and schema repair live?
- How should remote Skills be pinned and trusted?
- Which Sandbox providers are worth supporting after Docker?
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
- event-driven lifecycle extensions
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
- [vite-node](https://github.com/antfu-collective/vite-node)
