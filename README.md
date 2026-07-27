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

Nothing under `poc/` is part of the new package or public API.

```sh
npm run build
npm run typecheck
npm run test
npm run pack:check
npm run example:basic
npm run example:agent
```
