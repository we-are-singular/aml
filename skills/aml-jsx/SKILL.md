---
name: aml-jsx
description: Build, explain, test, or debug TypeScript agent workflows with Agent Markup Language and the @aml-jsx/sdk package. Use when a coding task involves AML, AML JSX/TSX trees, Agent/System/Tool/Skill/Mcp/FollowUp components, provider-agnostic multi-agent orchestration, explicit parallel agents, structured agent output, Sandboxes, Workspaces, OpenCode, Codex, GitHub Copilot, or Pi providers, or custom AML providers.
---

# Build with AML JSX

Use AML as an asynchronous JSX runtime for agent workflows. Treat the JSX tree as executable orchestration data, not as a React UI.

## Start from the installed API

AML is under active development. Before editing an existing project:

1. Read its `package.json`, TypeScript config, existing AML components, and lockfile.
2. Inspect the installed `@aml-jsx/sdk` types or the matching package version when an API is uncertain.
3. Reuse the project's provider construction, runtime options, schemas, and testing patterns.
4. Do not invent components, props, provider methods, or import paths.

For this repository, use `README.md`, `SPEC.md`, and `examples/src/` as the source of truth. Treat the Context and Loop surfaces as draft unless the user explicitly asks to work with them.

## Read current documentation on demand

Use the public documentation for current explanations, provider prerequisites, and examples. When network access is available, fetch the smallest page that answers the task by appending `.md` to its documentation route:

```sh
curl -fsSL https://agent-markup-language.com/docs/concepts.md
```

Fetch [the complete documentation corpus](https://agent-markup-language.com/docs/llms.txt) only when the task crosses several areas or the correct page is unclear. Start from [the docs index](https://agent-markup-language.com/docs.md) for its section map. Prefer a focused Markdown page over scraping HTML, and prefer the installed package types when live docs describe a newer AML version than the project uses.

## Configure TSX

Install the runtime:

```sh
npm install @aml-jsx/sdk
```

Use AML's automatic JSX runtime:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@aml-jsx/sdk"
  }
}
```

Use `.tsx` for files containing AML markup. Do not add React or import a React JSX runtime.

## Author a workflow

Construct providers once, outside render paths. Put provider-neutral workflow logic in ordinary async components:

```tsx
import { Agent, AmlRuntime, opencodeAgent } from "@aml-jsx/sdk"

const OpenCode = opencodeAgent({})

async function SummarizeRepository() {
  return <Agent provider={OpenCode}>Summarize this repository.</Agent>
}

const runtime = new AmlRuntime()
const result = await runtime.evaluate(<SummarizeRepository />)
```

Follow these semantics:

- Root work starts with `runtime.evaluate(tree)`.
- `evaluate(tree)` is only for work started inside an actively evaluated AML function component.
- AML resolves children from the leaves upward and preserves authored order.
- A nested Agent resolves before its parent Agent; its text becomes part of the parent prompt at the authored position.
- Sibling JSX does not imply concurrency. Start independent branches with `Promise.all()` and `evaluate()`.
- Keep JavaScript control flow in TypeScript: use functions, arrays, conditions, loops, and promises rather than inventing markup primitives.
- Inject providers through `<Agent provider={...}>` or runtime defaults so the tree remains provider-agnostic.
- Scope `<Tool>`, `<Mcp>`, `<Skill>`, and `<FollowUp>` to their nearest Agent.
- Use `<Sandbox>` for ephemeral execution policy and `<Workspace>` for durable files.

Read [authoring-workflows.md](references/authoring-workflows.md) for nesting, parallel work, structured output, and follow-up sessions.

For current public detail, fetch the [execution model](https://agent-markup-language.com/docs/concepts.md), [structured output cookbook](https://agent-markup-language.com/docs/cookbook/structured-output.md), or [primitive reference](https://agent-markup-language.com/docs/reference/primitives.md) as needed.

## Add capabilities and resources deliberately

Prefer AML's public definitions over provider-specific glue:

- Define JavaScript tools with `defineTool()` and grant them with `<Tool use={tool} />`.
- Configure native filesystem, shell, and network access with `<Agent permissions={...}>`; omitted permissions default optimistically on.
- Define stdio or Streamable HTTP MCP servers with `defineMcpServer()` and grant them with `<Mcp use={server} />`.
- Add reusable instructions with inline `<Skill>` content or `<Skill src="..." />`.
- Place Agents inside `<Sandbox>` and `<Workspace>` only when the workflow needs those boundaries.

Capabilities are lexical grants, not global registration. Never assume a Tool or MCP server granted to one Agent is visible to its siblings.

Read [capabilities-and-resources.md](references/capabilities-and-resources.md) before adding Tools, MCP servers, Skills, Sandboxes, or Workspaces.

Fetch the focused public guide when the task depends on a specific boundary: [Tools](https://agent-markup-language.com/docs/cookbook/tools.md), [MCP](https://agent-markup-language.com/docs/cookbook/mcp.md), [Sandboxes](https://agent-markup-language.com/docs/providers/sandboxes.md), or [Workspaces](https://agent-markup-language.com/docs/providers/workspaces.md).

## Select providers at the boundary

The public package currently exports built-in factories from one entry point:

```tsx
import { codexAgent, copilotAgent, modalSandbox, opencodeAgent, piAgent } from "@aml-jsx/sdk"

const Codex = codexAgent({})
const Copilot = copilotAgent({ model: "gpt-5-mini" })
const OpenCode = opencodeAgent({})
const Pi = piAgent({ model: "opencode-go/glm-5.1" })
const Modal = modalSandbox({ image: "node:26" })
```

Keep provider selection outside reusable workflow components when practical. Use `Agent` props such as `model` and `cwd` only for invocation-level overrides; keep provider-owned credentials and defaults in the provider factory.

Codex, GitHub Copilot, OpenCode, and Pi are thin profiles over AML's shared ACP session engine. Keep provider configuration on the selected factory and preserve vendor-native concepts where the profile exposes them. Copilot uses invocation-private state and does not import the interactive user's Copilot configuration. The selected local or Sandbox environment must contain the compatible ACP Agent executable; AML does not install one implicitly.

Read [providers-and-testing.md](references/providers-and-testing.md) for runtime defaults, tracing, deterministic tests, and provider conformance.

Use the current [provider catalog](https://agent-markup-language.com/docs/providers.md) to choose boundaries, then fetch the relevant [Agent](https://agent-markup-language.com/docs/providers/agents.md), [Sandbox](https://agent-markup-language.com/docs/providers/sandboxes.md), or [Workspace](https://agent-markup-language.com/docs/providers/workspaces.md) provider page before writing configuration.

## Validate behavior

Validate at the level changed by the task:

1. Type-check the TSX project.
2. Run focused behavior tests.
3. Exercise the workflow with deterministic providers before spending live model calls when possible.
4. Run live provider, Docker, or filesystem integration tests only when credentials and external services are intentionally in scope.
5. Check prompt assembly, capability isolation, output ordering, cleanup, and error behavior—not only the final string.

When changing AML itself, preserve the normative behavior in `SPEC.md`, update examples for public API changes, and run the repository's format, lint, test, build, and package checks.

Before proposing a production workflow, read the current [security boundaries](https://agent-markup-language.com/docs/production/security.md) and [deployment guide](https://agent-markup-language.com/docs/production/deployment.md).
