---
name: aml-jsx
description: Build, explain, test, or debug TypeScript agent workflows with Agent Markup Language and the @aml-jsx/sdk package. Use when a coding task involves AML, AML JSX/TSX trees, Agent/System/Tool/Skill/Mcp/FollowUp components, provider-agnostic multi-agent orchestration, explicit parallel agents, structured agent output, Sandboxes, Workspaces, OpenCode, Codex, or Pi providers, or custom AML providers.
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

## Add capabilities and resources deliberately

Prefer AML's public definitions over provider-specific glue:

- Define JavaScript tools with `defineTool()` and grant them with `<Tool use={tool} />`.
- Grant provider-native tools with `<Tool name="..." />`.
- Define stdio or Streamable HTTP MCP servers with `defineMcpServer()` and grant them with `<Mcp use={server} />`.
- Add reusable instructions with inline `<Skill>` content or `<Skill src="..." />`.
- Place Agents inside `<Sandbox>` and `<Workspace>` only when the workflow needs those boundaries.

Capabilities are lexical grants, not global registration. Never assume a Tool or MCP server granted to one Agent is visible to its siblings.

Read [capabilities-and-resources.md](references/capabilities-and-resources.md) before adding Tools, MCP servers, Skills, Sandboxes, or Workspaces.

## Select providers at the boundary

The public package currently exports built-in factories from one entry point:

```tsx
import { codexAgent, modalSandbox, opencodeAgent, piAgent } from "@aml-jsx/sdk"

const Codex = codexAgent({})
const OpenCode = opencodeAgent({})
const Pi = piAgent({ model: "opencode-go/glm-5.1" })
const Modal = modalSandbox({ image: "node:26" })
```

Keep provider selection outside reusable workflow components when practical. Use `Agent` props such as `model` and `cwd` only for invocation-level overrides; keep provider-owned credentials and defaults in the provider factory.

OpenCode's `config` and Pi's `providers` options deliberately retain their vendor SDK shapes. Do not translate them into a generic AML credential object. Pi is embedded as a package dependency and does not require a global Pi installation; it can use explicit provider configuration or Pi's ambient credential discovery.

Read [providers-and-testing.md](references/providers-and-testing.md) for runtime defaults, tracing, deterministic tests, and provider conformance.

## Validate behavior

Validate at the level changed by the task:

1. Type-check the TSX project.
2. Run focused behavior tests.
3. Exercise the workflow with deterministic providers before spending live model calls when possible.
4. Run live provider, Docker, or filesystem integration tests only when credentials and external services are intentionally in scope.
5. Check prompt assembly, capability isolation, output ordering, cleanup, and error behavior—not only the final string.

When changing AML itself, preserve the normative behavior in `SPEC.md`, update examples for public API changes, and run the repository's format, lint, test, build, and package checks.
