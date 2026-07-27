# Agent Markup Language

Agent Markup Language (AML) is an asynchronous TypeScript and JSX runtime for composing provider-agnostic agent workflows.

AML lets you describe agents, prompts, capabilities, execution environments, durable workspaces, and multi-step control flow as one executable tree. The runtime resolves that tree from the leaves upward, manages provider and resource lifecycles, and returns the final Agent output as text or validated structured data.

> AML is under active development. The packages in this repository are private and have not been published to npm.

## Why AML

Agent SDKs are good at running one provider session. Real workflows usually need more: parallel specialists, ordered synthesis, shared context, custom JavaScript tools, model-specific adapters, sandbox boundaries, durable files, follow-up turns, stateful loops, and useful traces.

Without a shared runtime, those concerns become orchestration code tied to one provider. AML keeps the workflow declarative while leaving each Agent provider responsible for its own model sessions and native capabilities.

```text
AML tree
  ├─ resolve components and context
  ├─ acquire Workspace and Sandbox resources
  ├─ run independent Agents through injected providers
  ├─ carry their results into parent prompts
  └─ release resources and return the final output
```

Ordinary JSX children resolve in authored order. Independent work becomes concurrent only when the component explicitly starts it with JavaScript primitives such as `Promise.all()`.

## Example

Configure TypeScript to use AML's automatic JSX runtime:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@aml/sdk"
  }
}
```

Then compose ordinary async components, Agents, and typed JavaScript Tools:

```tsx
import { readFile } from "node:fs/promises"

import { opencodeAgent } from "@aml/agent-opencode"
import {
  Agent,
  AmlRuntime,
  createConsoleTracer,
  defineTool,
  evaluate,
  Tool,
} from "@aml/sdk"
import { z } from "zod"

const OpenCode = opencodeAgent({})

const ReadSource = defineTool({
  name: "read_source",
  description: "Read one source file from the current project",
  input: z.object({ path: z.string() }),
  execute: async ({ path }) => await readFile(path, "utf8"),
})

async function Review() {
  const [correctness, maintainability] = await Promise.all([
    evaluate(
      <Agent provider={OpenCode} system="Find concrete correctness defects.">
        <Tool use={ReadSource} />
        Review src/index.ts.
      </Agent>,
    ),
    evaluate(
      <Agent provider={OpenCode} system="Find proportionate maintainability improvements.">
        <Tool use={ReadSource} />
        Review src/index.ts.
      </Agent>,
    ),
  ])

  return (
    <Agent provider={OpenCode} system="Synthesize evidence without inventing findings.">
      Correctness:
      {correctness}

      Maintainability:
      {maintainability}
    </Agent>
  )
}

const runtime = new AmlRuntime()
runtime.on("trace", createConsoleTracer())

console.log(await runtime.evaluate(<Review />))
```

The workflow stays the same when the provider changes. Replace `OpenCode` with a Codex provider or another `AgentProvider` implementation without rewriting the AML tree.

## Primitives

| Primitive | Purpose |
| --- | --- |
| `<Agent>` | Runs one provider-owned Agent session after its prompt, System content, capabilities, and child Agent results have resolved. |
| `<System>` | Adds resolved content to the owning Agent's system prompt. Multiple System blocks are joined in authored order. |
| `<Tool>` | Grants the owning Agent a provider-native Tool by name or a JavaScript Tool created with `defineTool()`. |
| `<Skill>` | Adds reusable inline or local-file instructions to the owning Agent. |
| `<Mcp>` | Grants the owning Agent a provider-native MCP server by name or an explicit server created with `defineMcpServer()`. |
| `<FollowUp>` | Adds a later turn to the same Agent session. FollowUps are flat, ordered, and resolved before the session starts. |
| `<Loop>` | Repeats fresh Agent sessions over immutable, schema-validated state until an iteration stops changing that state. |
| `<Sandbox>` | Acquires an ephemeral execution environment and scopes a narrowed filesystem policy to descendant Agents. |
| `<Workspace>` | Materializes durable files that can survive and be shared across disposable Sandbox leases. |
| `<Context.Provider>` | Provides an immutable application dependency to descendant components without rendering it into Agent prompts. |
| `<>...</>` | Groups AML values without adding prompt text or another runtime boundary. |

## Core APIs

| API | Purpose |
| --- | --- |
| `AmlRuntime` | Evaluates a complete AML tree, owns budgets and lifecycle events, and returns the final text output. |
| `evaluate()` | Evaluates AML from inside an active component and returns text or schema-validated structured data. |
| `defineTool()` | Turns a JavaScript function into a model-callable capability with validated input and optional validated output. |
| `defineMcpServer()` | Creates an immutable provider-neutral MCP descriptor for a local stdio process or remote Streamable HTTP server. |
| `createContext()` / `useContext()` | Defines and reads immutable dependencies scoped through the AML tree. |
| `defineAgentProvider()` | Defines an Agent harness adapter implementing AML's provider contract. |
| `defineSandboxProvider()` | Defines an ephemeral execution provider. |
| `defineWorkspaceProvider()` | Defines a durable filesystem materialization provider. |
| `runtime.on()` / `runtime.once()` | Subscribes to evaluation lifecycle and trace events. |

## Providers

AML's core runtime defines provider contracts and does not import concrete implementations.

| Role | Package | Factory | Notes |
| --- | --- | --- | --- |
| Agent | [`@aml/agent-opencode`](./providers/agents/opencode) | `opencodeAgent()` | Runs OpenCode sessions with model overrides, JavaScript Tools, MCP grants, FollowUps, cancellation, and structured output. |
| Agent | [`@aml/agent-codex`](./providers/agents/codex) | `codexAgent()` | Runs Codex SDK threads with model overrides, read-only host Tools, JavaScript Tools, MCP grants, FollowUps, and structured output. |
| Sandbox | [`@aml/sandbox-docker`](./providers/sandboxes/docker) | `dockerSandbox()` | Provides confined Docker container leases to compatible Agent providers with explicit filesystem, network, identity, capability, and resource policies. |
| Workspace | [`@aml/workspace-local`](./providers/workspaces/local) | `localWorkspace()` | Uses an existing local directory as a durable Workspace with cross-process writer locking. |
| Testing | [`@aml/sdk/testing`](./sdk/src/testing.ts) | Deterministic providers | Supplies deterministic Agent, Sandbox, and Workspace providers plus reusable conformance suites. |

`<System>`, `<Skill>`, `<FollowUp>`, `<Loop>`, Context, and tree evaluation are runtime-owned and work independently of the selected Agent provider. JavaScript Tool and MCP execution ultimately depend on the Agent provider; both bundled Agent adapters implement those capability bridges.

## Examples

Every example is one self-contained AML component. Run one with `npm run example -- <name>`.

| Example | Description |
| --- | --- |
| [`basic`](./examples/src/core/basic.tsx) | Resolves ordinary synchronous and asynchronous JSX components from the leaves upward. |
| [`agent`](./examples/src/core/agent.tsx) | Uses a child Agent to generate System content for its parent. |
| [`concurrency`](./examples/src/core/concurrency.tsx) | Runs two specialists concurrently and preserves authored result order for synthesis. |
| [`structured`](./examples/src/core/structured.tsx) | Passes schema-validated Agent data into a later text-producing Agent. |
| [`context`](./examples/src/core/context.tsx) | Injects a session repository and captures it inside a JavaScript Tool without adding it to the prompt. |
| [`follow-up`](./examples/src/core/follow-up.tsx) | Authors several turns inside one provider-owned Agent session. |
| [`loop`](./examples/src/core/loop.tsx) | Advances immutable, validated state between fresh Agent sessions. |
| [`skill`](./examples/src/capabilities/skill.tsx) | Adds reusable inline instructions to an Agent. |
| [`mcp`](./examples/src/capabilities/mcp.tsx) | Grants one Agent an MCP server while proving sibling capability isolation. |
| [`sandbox`](./examples/src/resources/sandbox.tsx) | Narrows nested Sandbox access while sharing one deterministic outer lease. |
| [`workspace`](./examples/src/resources/workspace.tsx) | Shares one durable materialization across disposable Sandbox leases. |
| [`opencode`](./examples/src/integrations/opencode.tsx) | Uses a credentialed OpenCode model to call a process-local JavaScript Tool. |
| [`review`](./examples/src/integrations/review.tsx) | Runs a parallel multi-agent code review through deterministic, OpenCode, or Codex providers. |
| [`docker`](./examples/src/integrations/docker.tsx) | Inspects a real Docker Sandbox's working directory and confinement settings. |
| [`workspace-local`](./examples/src/integrations/workspace-local.tsx) | Persists a file across disposable Sandbox runs through the local Workspace provider. |

The deterministic examples are snapshot-tested. Live model, Docker, and filesystem integrations are opt-in.

## Repository layout

```text
sdk/        @aml/sdk, the AML runtime and public API
providers/  optional Agent, Sandbox, and Workspace provider implementations
apps/       runnable products built on AML (reserved for future apps)
examples/   human-readable client workflows
poc/        archived Phase 0 experiments and research
```

[`SPEC.md`](./SPEC.md) is the normative behavior contract. [`PRD.md`](./PRD.md) records product decisions, architecture, and delivery status. [`PROVIDERS.md`](./PROVIDERS.md) tracks the provider implementation wishlist.

## Development

Requirements:

- Node.js 26 or newer
- npm 11 or newer
- Docker only for Docker integration tests and examples
- Configured OpenCode or Codex credentials only for live Agent examples

Install dependencies:

```sh
npm install
```

Common commands:

| Command | Purpose |
| --- | --- |
| `npm run test` | Run deterministic tests across every workspace. |
| `npm run typecheck` | Type-check the SDK, providers, and examples. |
| `npm run build` | Build every distributable package. |
| `npm run pack:check` | Validate built exports, packed files, and provider conformance. |
| `npm run example -- basic` | Run one example through built package exports. |
| `npm run example -- review` | Run the review workflow with its deterministic provider. |
| `AML_REVIEW_PROVIDER=opencode npm run example -- review` | Run the review workflow through OpenCode. |
| `AML_REVIEW_PROVIDER=codex npm run example -- review` | Run the review workflow through Codex. |
| `npm run example -- docker` | Run the real Docker Sandbox example. |

Package-specific integration suites are available through their workspace scripts:

```sh
npm run test:integration --workspace=@aml/agent-opencode
npm run test:integration --workspace=@aml/agent-codex
npm run test:integration --workspace=@aml/sandbox-docker
```

## License

This repository does not currently include a license. No permission to use, modify, or redistribute the project is granted until a license is added.
