# Authoring AML workflows

## Evaluation model

AML function components may be synchronous or asynchronous. Their returned values can include strings, numbers, arrays, promises, fragments, other components, and AML primitives. The runtime resolves the tree from the leaves upward.

Use `AmlRuntime` at the application boundary:

```tsx
import { Agent, AmlRuntime, opencodeAgent } from "@aml-jsx/sdk"

const runtime = new AmlRuntime({
  agentProvider: opencodeAgent({}),
  maxAgentCalls: 12,
  maxConcurrentAgents: 4,
})

const result = await runtime.evaluate(<Agent>Summarize the repository.</Agent>)
```

Use the runtime's `agentProvider` default when most Agents share one provider. Add an explicit `provider` prop when a branch needs another provider.

## Nested agents

A child Agent resolves first. Its output is inserted into the parent prompt at the authored position:

```tsx
function Review() {
  return (
    <Agent provider={Coordinator} system="Produce one evidence-based review.">
      Specialist finding:
      <Agent provider={Specialist}>Inspect the authorization path.</Agent>
      Synthesize the finding without inventing evidence.
    </Agent>
  )
}
```

Use nested Agents for dataflow dependencies. Do not use them merely for visual grouping.

## Explicit parallel work

JSX children resolve in authored order. Use `<Parallel>` when independent branch text should flow directly into the
surrounding AML tree:

```tsx
import { Agent, Parallel } from "@aml-jsx/sdk"

function Review() {
  return (
    <Agent provider={OpenCode}>
      <Parallel>
        <Agent provider={OpenCode}>Find concrete correctness defects.</Agent>
        <Agent provider={Codex}>Find proportionate maintainability improvements.</Agent>
      </Parallel>
      Produce one final review.
    </Agent>
  )
}
```

`<Parallel>` waits for every branch and its cleanup, preserves authored output order, and reports failures through
`ParallelError.failures`. It does not retry, cancel healthy siblings after a failure, or roll back successful side
effects. `maxConcurrentAgents` remains the Agent-session limit.

Use `Promise.all([evaluate(...), evaluate(...)])` inside an async component when JavaScript needs named or
schema-inferred branch values. `evaluate()` requires an active AML component evaluation; never call it as a detached
top-level substitute for `runtime.evaluate()`.

## Structured output

Declare `schema` on a nested Agent when its validated result should continue through ordinary AML text composition:

```tsx
<Agent provider={Coordinator}>
  Finding:
  <Agent provider={OpenCode} schema={Finding}>
    Inspect the authorization path.
    <FollowUp>Challenge the evidence, then submit the final finding.</FollowUp>
  </Agent>
</Agent>
```

The validated value renders as canonical JSON text. FollowUps run in authored order, and structured output is requested only on the final authored turn.

Pass the schema as the second argument to `evaluate()` when TypeScript needs its inferred value:

```tsx
import { Agent, evaluate } from "@aml-jsx/sdk"
import { z } from "zod"

const Finding = z.object({
  severity: z.enum(["low", "high"]),
  summary: z.string(),
})

async function Triage() {
  const finding = await evaluate(<Agent provider={OpenCode}>Inspect the authorization path.</Agent>, Finding)

  return (
    <Agent provider={OpenCode}>
      Explain this {finding.severity} finding: {finding.summary}
    </Agent>
  )
}
```

Use one schema owner per Agent: either its `schema` prop for JSON-text composition or `evaluate(value, schema)` for typed collection. Use plain text for prompts and final prose.

## System content and follow-ups

Use the `system` prop for a simple static system prompt. Use `<System>` when the system prompt contains resolved AML content:

```tsx
<Agent provider={Coordinator}>
  <System>
    Follow this specialist-generated rule:
    <Agent provider={Specialist}>Write one review rule.</Agent>
  </System>
  Review the change.
</Agent>
```

Use `<FollowUp>` for later turns in the same Agent session:

```tsx
<Agent provider={OpenCode}>
  Investigate the implementation.
  <FollowUp>Challenge the evidence.</FollowUp>
  <FollowUp>Produce the final review.</FollowUp>
</Agent>
```

Follow-ups are authored and resolved before the provider session starts. They are ordered, flat later inputs—not dynamically generated turns.
