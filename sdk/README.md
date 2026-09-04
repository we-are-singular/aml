# `@aml-jsx/sdk`

Agent Markup Language (AML) is an asynchronous TypeScript and JSX runtime for composing provider-agnostic agent workflows.

```sh
npm install @aml-jsx/sdk
```

Configure TypeScript to use AML's JSX runtime:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@aml-jsx/sdk"
  }
}
```

Then evaluate an AML tree:

```tsx
import { Agent, AmlRuntime, opencodeAgent } from "@aml-jsx/sdk"

const runtime = new AmlRuntime()
const result = await runtime.evaluate(<Agent provider={opencodeAgent({})}>Summarize this repository.</Agent>)
```

## Typing application components

Import `AML` as a type when declaring reusable workflow components. `AML.Component<Props>` accepts synchronous or asynchronous AML values and does not add an implicit `children` prop. Add optional or required children deliberately with the matching props helper:

```tsx
import type { AML } from "@aml-jsx/sdk"

type SectionProps = AML.PropsWithRequiredChildren<{
  readonly title: string
}>

const Section: AML.Component<SectionProps> = ({ children, title }) => [title, ": ", children]

const workflow: AML = <Section title="Evidence">Inspect the changed files.</Section>
```

`AmlRenderable` remains available as the descriptive equivalent of `AML`.

The built-in coding-agent factories are thin profiles over AML's shared Agent Client Protocol (ACP) session engine:

```tsx
import { Agent, AmlRuntime, piAgent } from "@aml-jsx/sdk"

const Pi = piAgent({
  env: { OPENCODE_API_KEY: process.env.OPENCODE_API_KEY ?? "" },
  model: "opencode-go/deepseek-v4-flash",
})

const result = await new AmlRuntime().evaluate(<Agent provider={Pi}>Say hello.</Agent>)
```

Codex, GitHub Copilot, GLM, OpenCode, and Pi use the same ACP lifecycle on the trusted local host and inside supported Sandboxes. GLM launches the community-maintained `glm-acp-agent` adapter rather than Z.ai's ZCode harness. Agents optimistically receive their native filesystem, shell, and network capabilities unless `<Agent permissions>` narrows them; the enclosing Sandbox remains authoritative. `<Tool>` is reserved for JavaScript functions created with `defineTool()`. The selected environment must contain the compatible ACP Agent executable; AML does not install it implicitly. Provider-specific options remain on each factory.

`<Agent name="reviewer">` adds optional diagnostic metadata for relating traces and failures to the authored workflow. It must be a non-empty normalized string when supplied. Names are not unique: structural identities such as trace span IDs continue to distinguish Agents with the same name. AML includes the name in observability and diagnostics only; it never adds it to the prompt or system instructions sent to the provider.

`<Agent timeoutMs={...}>` optionally bounds one provider session after it acquires an execution slot. The value must be a positive safe integer. AML derives a session signal that aborts when either this timeout expires or the enclosing evaluation is cancelled; the earliest cause wins, and nested Agents retain independent scopes. Expiry follows the same provider cancellation path as caller cancellation. AML awaits provider-owned abort and cleanup before settling the Agent, and preserves both the cancellation cause and any later cleanup failure.

`<Agent schema={Result}>` validates that Agent's structured result and contributes canonical JSON text to ordinary AML composition. An authored `<FollowUp>` sequence remains valid: AML asks for structured output only on the final authored turn. Use `evaluate(<Agent>...</Agent>, Result)` instead when component code needs the schema-inferred value.

`defineTool()` returns a typed callable. Calling it from an active AML function component validates through the same registered execution path used by Agents, but does not grant the Tool to an Agent or expose anything to a model and needs no surrounding Agent. The call inherits evaluation cancellation and tracing, runs in the AML host process even beneath `<Sandbox>`, and is joined before the component's enclosing resources clean up even when its Promise is not explicitly awaited. Pass the same Tool to `<Tool use={tool} />` only when a model should receive that capability.

`<Parallel>` evaluates independent AML branches concurrently, waits for every branch and its cleanup to settle, then
contributes successful text in authored order. Agent-owned `schema` values remain canonical JSON text inside a branch.
`AmlRuntime.maxConcurrentAgents` still bounds active Agent sessions; `<Parallel>` adds no second concurrency limit.
When any branch fails, it throws `ParallelError` with ordered, zero-based `{ branchIndex, cause }` entries after all
branches settle. It does not retry, cancel siblings after a failure, or roll back completed side effects.

```tsx
<Agent provider={Pi}>
  <Parallel>
    <Agent>Review correctness.</Agent>
    <Agent>Review maintainability.</Agent>
  </Parallel>
  Synthesize the reviews.
</Agent>
```

An unsandboxed `<Script />` runs as a trusted host process from `AmlRuntimeOptions.cwd`, defaulting to `process.cwd()`. Inside an active `<Sandbox />`, it runs only through that Sandbox runtime and never falls back to the host. Its optional portable `cwd` resolves from the runtime cwd on the host or from the active Sandbox root.

The public factory names are `codexAgent()`, `copilotAgent()`, `glmAgent()`, `opencodeAgent()`, and `piAgent()`.

## Application observability

Use `withTraceSpan(name, operation)` inside a function component to time application work that automatic component and
primitive spans cannot isolate. AML owns correlation identities and closes spans on success, failure, and cancellation.

`createTraceSummaryCollector()` derives content-free summaries from public trace events. Read them with `forRun(runId)`;
there is deliberately no concurrency-ambiguous latest-run API. Provider usage remains optional provider-reported JSON,
Agent cleanup outcomes have their own field, and trace-consumer failures continue through `AmlRuntime.onTraceError`. The
collector does not rewrite evaluation status. AML does not infer model calls, costs, cache behavior, or missing token
fields. Its `acpToolCalls` aggregate counts initial provider-reported ACP tool calls by exact capability name without
retaining arguments, results, updates, prompts, or model text. Names do not portably identify a backend or MCP server.
This is separate from `tools`, which measures declarative AML `<Tool>` execution spans; a routed call may appear in both.

## Coding agents

Install AML's coding-agent skill for current workflow patterns, runtime semantics, providers, and testing guidance:

```sh
npx skills add we-are-singular/aml --skill aml-jsx
```

Add `-g` for a global installation.

AML is under active development. Public APIs and examples may change before the first stable release.

- [Documentation and examples](https://github.com/we-are-singular/aml)
- [Specification](https://github.com/we-are-singular/aml/blob/main/SPEC.md)
- [Project website](https://agent-markup-language.com/)

## License

MIT
