# Agent Markup Language

Agent Markup Language (AML) is a TypeScript and JSX runtime for composing provider-agnostic agent workflows.

The project is being rebuilt from the Phase 0 proof of concept:

- [SPEC.md](./SPEC.md) defines required AML behavior.
- [PRD.md](./PRD.md) defines the product, architecture, implementation roadmap, and delivery status.
- [`poc/`](./poc/) preserves disposable prototype code and research.

Phase 1 Slice 0 implements the fresh evaluation foundation:

- `@aml/sdk` exports the automatic JSX runtime and `AmlRuntime`.
- Components are invoked once per evaluated occurrence.
- Arrays, Fragments, Promises, empty values, strings, and numbers resolve deterministically into one string.
- `examples/basic` runs unbuilt TSX through vite-node while importing the SDK exclusively through its built `dist` exports.

Slice 1 adds provider-neutral `<Agent>` and `<System>` boundaries, `defineAgentProvider()`, deterministic fixtures under `@aml/sdk/testing`, Agent-call budgets, and cross-package primitive identity. `examples/agent` demonstrates a child Agent generating system text for its parent.

Slice 2 adds the independently installable `@aml/agent-opencode` adapter. It starts OpenCode lazily, creates and cleans up one session per Agent, propagates cancellation, disables undeclared tools, and exposes a narrow injected session-client port for deterministic tests.

Slice 3 adds Agent-scoped `<Tool>` grants and `defineTool()`. JavaScript Tools use Standard Schema for runtime validation and Standard JSON Schema for model declarations, retain exact cross-copy identity, and return immutable JSON. The OpenCode adapter exposes them through authenticated invocation-scoped MCP bridges on disposable OpenCode hosts so dynamic registrations cannot accumulate. `examples/opencode` proves a credentialed `opencode-go/minimax-m3` model can call a process-local async function through built package exports.

Nothing under `poc/` is part of the new package or public API.

```sh
npm run build
npm run typecheck
npm run test
npm run pack:check
npm run example:basic
npm run example:agent
npm run example:opencode
```

`npm run example:opencode` is an explicit live model call. Set `AML_OPENCODE_MODEL` to override its default model.
