# Agent Markup Language specification

Status: living normative desired state

Implementation language: TypeScript with JSX

This document is the source of truth for Agent Markup Language (AML). Every unqualified rule describes required behavior, regardless of current implementation status. Contract changes begin here before the implementation roadmap changes.

Product goals, architecture, phase planning, and implementation status live in [PRD.md](./PRD.md). Tests provide executable implementation evidence. Only sections explicitly labelled non-normative or Futurology are outside the required contract.

## 1. What AML is

AML is a TypeScript-embedded DSL and asynchronous runtime for coordinating agents, tools, context, and execution resources with JSX.

AML is:

- an SDK used from ordinary TypeScript
- an orchestration layer over provider-owned agent harnesses
- provider-agnostic at the authored workflow boundary
- post-order: dependencies resolve before their consumers
- explicit about capabilities and model execution
- ordinary async JavaScript inside components

AML is not:

- React or a UI renderer
- standalone XML
- a textual language with a custom parser
- a replacement for OpenCode, Codex, Claude, or another agent harness
- a mechanism for evaluating model output as source code
- a distributed workflow engine

The canonical application entry point is an ordinary `main.tsx`:

```tsx
const runtime = new AmlRuntime({
  agentProvider: provider,
  ...options,
});
const result = await runtime.evaluate(<Application />);
console.log(result);
```

The runtime Agent provider is optional until an `<Agent>` requires it. Applications own provider construction, credentials, runtime configuration, and cleanup. A CLI is outside the AML language contract. Any `aml run main.tsx` command must execute the same TypeScript entry point and must not introduce a second AML syntax or require an `.aml` filename.

### 1.1 Authored control flow

The developer authors the executable tree. Model output is always data.

If an Agent returns:

```xml
<Agent>Run another agent</Agent>
```

AML returns those exact characters. It does not parse or execute them.

Ordinary TypeScript owns finite control flow, branching, composition, and dependency injection. AML primitives exist only where the runtime must provide distinct execution semantics.

### 1.2 Provider-agnostic orchestration

An AML tree may coordinate Agents backed by different harnesses. Each harness keeps its native:

- model and credentials
- conversation implementation
- internal model/tool loop
- host tools
- token and usage accounting
- sandbox integration
- provider-specific events

AML standardizes how authored data flows into those boundaries and how their final results flow back into the tree. It does not pretend the providers have identical capabilities.

The runtime may supply a default Agent provider, and each Agent may override it with another configured provider instance. `model` is the portable per-Agent provider override. Provider-specific settings remain on the provider's configured factory unless AML later defines a real cross-provider contract for them.

### 1.3 Package boundary

AML is developed as an npm workspace monorepo. Its provider-neutral runtime is distributed as `@aml/sdk`, and concrete integrations are independently installable packages:

```text
@aml/agent-opencode
@aml/agent-codex
@aml/agent-claude
@aml/sandbox-local
@aml/sandbox-docker
@aml/sandbox-daytona
@aml/sandbox-cloudflare
@aml/workspace-local
@aml/workspace-s3
```

`@aml/sdk` owns the JSX runtime, evaluator, primitives, public provider interfaces, provider definition helpers, and conformance contracts. It must not import concrete providers or their vendor dependencies. Concrete provider packages depend on `@aml/sdk`, own their vendor-specific configuration and lifecycle, and expose configured factories.

The SDK exports both `@aml/sdk/jsx-runtime` and `@aml/sdk/jsx-dev-runtime` for TypeScript and Vite's automatic production and development JSX transforms.

Each distributable package owns one leaf build over its complete source import graph. Neutral workspace source may be compiled directly when it is not a public package boundary. A concrete provider build consumes the built public `@aml/sdk` contract first and keeps it external rather than embedding another SDK copy. A build must not reverse the package boundaries above: in particular, `@aml/sdk` never imports or bundles a concrete provider.

Examples and applications consume built package exports for every distributable package under proof. They must not bypass those exports through source paths or TypeScript aliases.

AML node and primitive interoperability markers must be copy-stable. The exported JSX node type uses a structural symbol-valued discriminant rather than a copy-local unique-symbol key, so an arbitrary `{ type, props }` object is not renderable while TypeScript code using one physical `@aml/sdk` copy can compose nodes evaluated by another compatible copy.

AML does not use names such as `@aml/agents/opencode` for independently installed providers because npm interprets that form as the `opencode` subpath of one `@aml/agents` package. Convenience aggregator packages are non-normative and may exist later, but cannot replace independently installable adapters.

## 2. Evaluation model

AML has two conceptual phases:

1. **Resolution** turns authored JSX into text and typed runtime descriptors.
2. **Execution** consumes those descriptors at boundaries such as `<Agent>`, `<Loop>`, `<Sandbox>`, and `<Workspace>`.

Not every resolved child becomes prompt text:

- text becomes message content
- `<System>` becomes an Agent system-prompt fragment
- `<Tool>` becomes an Agent capability
- `<Mcp>` becomes an Agent-scoped MCP server grant
- `<FollowUp>` becomes a staged later message
- `<Context.Provider>` changes descendant evaluation context
- `<Sandbox>` and `<Workspace>` own resource scopes

This distinction is important. A descriptor may be consumed later without its JSX being evaluated later.

### 2.1 Post-order consumers and lexical scopes

The core dataflow invariant is:

> Every value consumed by an AML boundary is fully resolved before that consumer executes.

`<Agent>` is the primary post-order consumer: child Agents, System fragments, Skills, text, Tools, MCP servers, and FollowUps all resolve into its complete session plan before the provider session begins.

Lexical resource boundaries have the complementary lifecycle:

1. enter or acquire the scope
2. evaluate descendants inside it
3. exit or release the scope after the subtree settles

`<Context.Provider>`, `<Sandbox>`, and `<Workspace>` are lexical scopes, not post-order consumers. They follow the same wrapper lifecycle. Their descendant Agents still obey post-order resolution within the active scope.

For a normal nested Agent:

```tsx
function GetContext() {
  return <Agent>Find the customer context.</Agent>;
}

const workflow = (
  <Agent>
    <GetContext />
    {"\nDecide what to do next."}
  </Agent>
);
```

AML:

1. evaluates `GetContext`
2. runs its Agent
3. receives the child Agent's final text
4. inserts that text at the authored position
5. runs the parent Agent last
6. returns the parent Agent's final text

AML evaluates JSX siblings from left to right. Independent work can run concurrently through ordinary JavaScript:

```tsx
const [review, audit] = await Promise.all([
  evaluate(<Reviewer />, ReviewResult),
  evaluate(<Auditor />, AuditResult),
]);
```

Implicit sibling concurrency is outside the normative evaluation model. Parent/child dependencies remain post-order.

### 2.2 Evaluation domains

One root `runtime.evaluate()` call creates one evaluation domain containing:

- one run identity
- Agent-call and state-transition budgets
- one Agent-concurrency scheduler
- scoped context values
- resource scopes
- one trace tree

Component-local `evaluate()` calls remain in the same domain. They share its budgets, cancellation, context, and traces.

The root evaluation accepts a caller-owned cancellation signal:

```ts
interface AmlEvaluationOptions {
  signal?: AbortSignal;
}

runtime.evaluate(tree, { signal });
```

An already-aborted signal rejects before evaluation begins. A signal aborted during evaluation is propagated to active provider calls and prevents the runtime from advancing to another AML frame. AML cannot forcibly interrupt arbitrary component Promises or reverse effects that already completed; components and providers must cooperate with cancellation at their own boundaries.

### 2.3 Errors and effects

AML fails closed:

- invalid component output rejects evaluation
- invalid descriptor placement rejects before its parent executes
- provider failure rejects the containing Agent
- schema failure rejects structured evaluation
- resource and policy failure reject instead of silently falling back
- exceeded budgets reject evaluation

AML cannot automatically roll back arbitrary effects already performed by an Agent or tool. Filesystem changes, database writes, network calls, and other external effects may survive a later failure. Transactional behavior exists only where a primitive explicitly guarantees it.

## 3. Language surface

### 3.1 Normative surface

| Surface | Purpose | Result |
| --- | --- | --- |
| `<Fragment>` / `<>` | Group authored siblings | Ordered child results |
| `AmlRuntime` | Own one complete evaluation | Final string |
| `<Agent>` | Execute one Agent boundary | Final text |
| `<System>` | Contribute resolved text to an Agent's system prompt | System descriptor |
| `defineAgentProvider()` | Define an Agent harness adapter | `AgentProvider` |
| `<Tool>` | Grant a host or JavaScript capability | Tool descriptor |
| `defineTool()` | Expose a JavaScript function to an Agent | Tool definition |
| `<Skill>` | Resolve reusable instruction text | Text |
| `<Sandbox>` | Scope an ephemeral execution lease and restrictive filesystem policy | Descendant execution scope |
| `defineSandboxProvider()` | Define an ephemeral execution adapter | `SandboxProvider` |
| `<Workspace>` | Load and save one durable working directory | Descendant filesystem root |
| `defineWorkspaceProvider()` | Define a durable workspace adapter | `WorkspaceProvider` |
| `<Mcp>` | Grant a provider-native or explicitly configured MCP server | MCP server descriptor |
| `defineMcpServer()` | Define an explicitly configured MCP server grant | MCP server definition |
| `evaluate()` | Evaluate AML as component-local data | `Promise<string \| T>` |
| `<FollowUp>` | Stage another input in the same Agent session | Turn descriptor |
| `<Loop>` | Repeat fresh Agents over validated state snapshots | Final text |
| `<Context.Provider>` | Scope an immutable dependency downward | Descendant context |
| `createContext()` / `useContext()` | Define and read scoped dependencies | Typed value |

### 3.2 Delivery phases

The normative surface is delivered in phases so the public API grows only after each earlier boundary has deterministic proof.

| Phase | Surface | Purpose |
| --- | --- | --- |
| Foundation | JSX values, Fragments, async components, `AmlRuntime` | Prove single-invocation asynchronous evaluation |
| MVP 1 | `<Agent>`, `<System>`, `defineAgentProvider()` | Establish the provider-neutral execution and message-channel boundary |
| MVP 2 | `<Tool>`, `defineTool()` | Add scoped host and JavaScript capabilities |
| MVP 3 | `<Skill>` | Add reusable instruction resolution |
| MVP 4 | `<Sandbox>`, `defineSandboxProvider()` | Add ephemeral execution scope |
| MVP 5 | `<Workspace>`, `defineWorkspaceProvider()` | Add durable filesystem scope and complete the MVP |
| Post-MVP capabilities | `<Mcp>`, `defineMcpServer()` | Attach MCP servers without making the SDK own an Agent harness |
| Post-MVP orchestration | `evaluate()`, structured output, `<FollowUp>`, `<Loop>` | Add richer dataflow and same-session or iterative execution |
| Late surface | `createContext()`, `useContext()`, `<Context.Provider>` | Add immutable dependency scope only after the execution and resource model is stable |

This is a delivery order, not a hierarchy of importance. Later primitives remain normative desired state, but they must not shape earlier implementations beyond the explicit extension points in their contracts.

### 3.3 Reserved and non-normative surfaces

AML does not specify:

- Agents exposed as model-callable tools
- external Agent Function components
- a dedicated `defineAgent()` abstraction
- an Effect-based evaluator
- Flue integration

These ideas are not part of the language. Agent-as-Tool is discussed only in section 17, Futurology.

## 4. Renderable values and components

An AML component may return:

- `string` or `number`, which contributes text
- `null`, `undefined`, or a boolean, which contributes no text
- an AML JSX element
- a readonly array of renderable values
- a Promise of any supported value

Plain objects are not renderable. Authors must serialize them explicitly or move them through typed `evaluate()` results.

Strings contribute their exact characters. Numbers use JavaScript string conversion. Empty values contribute an empty string. Arrays and Fragments recursively concatenate their resolved children without inserting separators. Nested arrays are valid.

AML awaits sibling results in authored order. A Promise created before AML receives it has already started according to ordinary JavaScript semantics and may make progress concurrently; AML does not attempt to serialize work that the application started itself.

```tsx
async function CustomerContext() {
  const customer = await database.customers.find(42);
  return `Customer: ${customer.name}`;
}
```

All components are asynchronous computations even when their functions do not use the `async` keyword.

### 4.1 Ordinary async semantics

AML invokes a component exactly once for each evaluated occurrence and awaits its result. Reusing the same JSX value in two authored positions creates two evaluated occurrences; AML does not memoize component results by element identity.

```tsx
async function Workflow() {
  const research = await evaluate(<Agent>Research the customer.</Agent>);

  return <Agent>Decide using: {research}</Agent>;
}
```

AML does not throw Promises, suspend a render, track hook positions, or invoke the component a second time. Code before and after `await` follows ordinary JavaScript semantics.

### 4.2 TypeScript control flow

Use TypeScript for conditions and finite authored collections:

```tsx
function Reviewer({ deep }: { deep: boolean }) {
  return (
    <Agent>
      {deep ? <Skill src="./skills/deep.md" /> : "Run a compact review."}
      Review the patch.
    </Agent>
  );
}
```

AML does not define `<If>`, `<Else>`, `<Map>`, or `<Sequence>`. Those would duplicate the host language without adding runtime behavior.

## 5. `<Agent>` sessions

An `<Agent>` is one Agent-session boundary. It may contain one initial input and multiple sequential provider turns through `<FollowUp>`.

```tsx
<Agent
  model="opencode-go/minimax-m3"
  provider={openCode}
  system="You are a support operations lead."
>
  <System>Prefer concrete operational evidence.</System>
  <Tool name="support.search" />
  Investigate customer 42.
</Agent>
```

Props:

```ts
interface AgentProps {
  children?: AmlRenderable;
  model?: string;
  provider?: AgentProvider;
  system?: string;
}
```

`provider` selects the harness for this Agent. When omitted, AML uses `AmlRuntimeOptions.agentProvider`. An Agent without either provider is invalid. Different Agents in one evaluation may select different providers while remaining in the same evaluation domain.

`model` is a provider-neutral override whose string remains provider-owned. Resolution order is the Agent `model` prop, then the configured provider's default, then the provider-native default. AML passes the explicit prop through `AgentRequest.model`; the selected provider rejects identifiers it cannot use.

`system` is the concise fixed-text system prompt. `<System>` is the composable form for resolved asynchronous content. Provider-specific settings that have no portable AML semantics belong to configured provider instances, not arbitrary Agent props or an untyped `providerOptions` bag.

### 5.1 Agent plan

AML completely resolves Agent children before opening the provider session. The conceptual result is an Agent plan:

```ts
interface AgentPlan {
  initialPrompt: string;
  followUps: readonly string[];
  mcpServers: readonly AgentMcpServer[];
  model?: string;
  system: string;
  systemFragments: readonly string[];
  tools: readonly AgentTool[];
}
```

This interface illustrates the semantics; it is not necessarily the exported runtime type.

`systemFragments` is the ordered internal list after runtime, prop, and child resolution. The Agent provider receives only the joined `system` string.

Resolution:

1. Resolve all descendants post-order.
2. Preserve resolved text in authored order.
3. Collect resolved System descriptors in authored order.
4. Collect Agent-level Tool descriptors.
5. Collect Agent-level MCP server descriptors.
6. Collect flat FollowUp descriptors in authored order.
7. Trim the initial prompt, each FollowUp prompt, and each system fragment.
8. Build the provider system text from the runtime `system`, Agent `system` prop, and collected System descriptors, omitting empty fixed-text entries and joining the remaining entries with `"\n"`.
9. Reject invalid or duplicate capabilities.
10. Open one provider session and execute the plan.

Text children are concatenated without implicit separators. JSX indentation is ordinary authored text; developers should add deliberate whitespace where needed.

### 5.2 `<System>` prompts

`<System>` changes the provider message channel for its nearest containing Agent:

```tsx
<Agent provider={coordinator} system="You coordinate specialist evidence.">
  <System>
    <Agent provider={policyWriter} model="anthropic/claude-haiku-4-5">
      Produce compact decision rules for this request.
    </Agent>
  </System>
  <System>
    <Skill src="./skills/evidence.md" />
  </System>
  Apply the generated rules to the request.
</Agent>
```

AML resolves each System subtree before opening the containing Agent session. Any AML subtree that ultimately resolves to text may contribute, including ordinary components, Skills, scoped resources, Loops, and child Agents. A child Agent inside `<System>` is a real child session; its final text becomes system text for the parent rather than initial-prompt text.

System rules:

- `<System>` is valid only as an immediate message descriptor of its nearest Agent after component and Fragment expansion.
- A System descriptor must resolve to non-empty text after trimming.
- Tool, MCP, FollowUp, and nested System descriptors that escape a nested consumer and reach the System text boundary are invalid.
- A Tool, Skill, or other capability used by a child Agent inside System remains scoped to that child Agent.
- System output never contributes to the containing Agent's initial prompt.
- Multiple System descriptors preserve authored order even when other prompt text appears between them.
- The final provider system text is `systemFragments.join("\n")`; AML inserts no additional blank lines.

`<Agent system="...">` remains the preferred concise form for one fixed instruction. `<System>` exists for reusable, conditional, or asynchronously resolved system content. AML does not define `<Model>` because `model` is scalar Agent request metadata and can already receive any TypeScript expression.

### 5.3 Child Agents

A child Agent is deterministic authored composition:

```tsx
<Agent>
  <RepositoryResearch />
  <SecurityReview />
  Synthesize the preceding evidence.
</Agent>
```

The child Agents finish before the parent Agent session begins. Their final texts are inserted into the parent input at their authored positions. They do not become distinct provider message roles.

AML evaluates these siblings left to right. Explicit `Promise.all(evaluate(...))` is the normative parallel form.

### 5.4 Agent result

Without structured output, the Agent element resolves to the final assistant text from its session. With FollowUps, intermediate assistant responses remain in provider session history and traces but do not become AML output.

An Agent with one input returns that input's response. An Agent with FollowUps returns the response to the last successful FollowUp.

## 6. `<FollowUp>`

`<FollowUp>` stages another authored user input in the same Agent session:

```tsx
<Agent>
  <Tool use={searchCode} />
  <Skill src="./skills/review.md" />
  Investigate the authentication implementation.
  <FollowUp>Challenge your findings and check for counterexamples.</FollowUp>
  <FollowUp>Produce the final review.</FollowUp>
</Agent>
```

The complete AML tree resolves first. Provider execution then:

1. opens one Agent session
2. sends the initial prompt
3. waits for its assistant response
4. sends each FollowUp sequentially
5. waits for each response before sending the next
6. returns the final response

The provider owns conversation history. AML does not append prior assistant responses into later user prompts.

### 6.1 Placement and shape

FollowUps form a flat ordered list.

- `<FollowUp>` is valid only within one containing Agent.
- After component and Fragment expansion, it must be an immediate message descriptor of that Agent.
- Multiple FollowUps execute in declaration order.
- A FollowUp must resolve to non-empty text.
- A FollowUp outside an Agent is invalid.
- A FollowUp nested inside another FollowUp is invalid.
- `<Tool>` inside a FollowUp is invalid.
- `<Mcp>` inside a FollowUp is invalid.
- FollowUps form the trailing message portion of an Agent: after the first FollowUp, non-whitespace text outside another FollowUp is invalid.

Invalid:

```tsx
<FollowUp>
  Challenge the findings.
  <FollowUp>Produce the report.</FollowUp>
</FollowUp>
```

Use flat siblings:

```tsx
<Agent>
  Investigate the problem.
  <FollowUp>Challenge the findings.</FollowUp>
  <FollowUp>Produce the report.</FollowUp>
</Agent>
```

Reusable components may return a Fragment or array of sibling FollowUps. The resolved Agent plan must still be flat. Formatting whitespace between trailing FollowUps contributes no message and is ignored.

### 6.2 Skills and capabilities

Tools and MCP servers are Agent-session capabilities and must be declared at Agent level. The same declared capabilities remain available throughout all turns.

AML does not promise turn-specific Tool or MCP grants. Provider support differs, and prompting a model not to use an available capability is not a security boundary. Use separate Agents when capability separation matters.

`<Skill>` is instruction text rather than an executable capability. A Skill at Agent level contributes to the initial prompt. A Skill inside a FollowUp contributes only to that FollowUp's text:

```tsx
<Agent>
  Inspect the implementation.
  <FollowUp>
    <Skill src="./skills/adversarial-review.md" />
    Re-evaluate the evidence.
  </FollowUp>
</Agent>
```

Model, provider, Sandbox, Workspace, system instructions, Tool grants, and MCP grants are session-wide.

### 6.3 State between turns

The word state refers to three different things:

| State | Visibility in the next FollowUp |
| --- | --- |
| Provider conversation history | Visible automatically in the same session |
| Filesystem, database, and tool effects | Visible if the same resource scope exposes them |
| AML Loop state | Still staged; committed only after the complete Agent session |

A FollowUp never causes JSX to re-evaluate. If an Agent inside `<Loop>` calls `aml_set_state` during its initial input, later FollowUps know about the tool call through conversation history, but they do not receive a newly rendered state snapshot. The Loop commits only after the Agent session finishes.

Context values are immutable scopes and never mutate between turns.

### 6.4 Conditional and dynamic FollowUps

TypeScript may include or omit a FollowUp using data available before the Agent session:

```tsx
<Agent>
  Investigate the implementation.
  {deepReview && <FollowUp>Check every caller and test.</FollowUp>}
  <FollowUp>Produce the final answer.</FollowUp>
</Agent>
```

A FollowUp cannot be dynamically authored from a preceding response because all AML descendants resolve before the Agent session begins.

Use typed Agent boundaries and TypeScript for response-dependent branching:

```tsx
const classification = await evaluate(
  <Agent>Classify this defect.</Agent>,
  Classification,
);

return classification.kind === "security" ? (
  <Agent>Perform a security review: {classification.summary}</Agent>
) : (
  <Agent>Perform a correctness review: {classification.summary}</Agent>
);
```

This starts a new Agent session. Host-controlled dynamic branching within a retained session is outside the FollowUp contract and is discussed in Futurology.

### 6.5 Failure and output

FollowUps fail closed:

- if the initial input fails, no FollowUp runs
- if a FollowUp fails, later FollowUps do not run
- any failed turn fails the complete Agent
- an earlier successful response is not substituted as Agent output
- intermediate responses remain available only through traces or provider-specific diagnostics
- already completed external effects are not rolled back

Structured output applies to the final authored input. Intermediate responses are ordinary text owned by the provider session.

## 7. `<Skill>`

`<Skill>` contributes reusable instruction text at its authored position:

```tsx
<Agent>
  <Skill src="./skills/review.md" />
  Review the change.
</Agent>
```

### 7.1 Content

Skill content comes from a local file, inline AML children, or both:

```tsx
<Skill src="./skills/reviewer.md" />

<Skill name="evidence" description="Prefer implementation evidence.">
  Verify each claim against code and tests.
</Skill>

<Skill src="./skills/base.md" name="generated-review">
  Add this dynamically generated guidance: <GuidanceAgent />
</Skill>
```

Rules:

- At least one of `src` or children is required.
- `src` is a non-empty local filesystem path. Relative paths resolve from `AmlRuntimeOptions.cwd`, which defaults to `process.cwd()`. Absolute paths remain absolute.
- The file is read during evaluation. AML does not embed Skill files at build time, cache their contents, fetch remote URLs, resolve registries, install supporting files, or execute scripts.
- Inline children use ordinary post-order AML evaluation. A child Agent may therefore generate part or all of a Skill.
- When both `src` and children exist, inline children resolve first, the file is read during the Skill completion step, and the final content is `fileContent + "\n" + childContent`.
- The combined content must contain non-whitespace text.
- `name` and `description` are optional non-empty strings without leading or trailing whitespace.
- Metadata decorates the combined content deterministically. Present metadata lines are emitted in `Skill: {name}`, then `Description: {description}` order, followed by one blank line and the combined content.
- Without metadata, the combined content is contributed unchanged.
- Filesystem failures are attributed to `<Skill>`. Cancellation preserves the caller's `AbortSignal.reason`.
- Local Skill access is not confinement. The future Sandbox and Workspace scopes define which filesystem paths an evaluation may access.

## 8. Tools

Tools are capabilities, not render-time calls.

`<Tool>` is a capitalized exported component. AML does not define lowercase HTML-like intrinsic elements.

```ts
type ToolProps = { name: string; use?: never } | { name?: never; use: AmlTool };

type AmlJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AmlJsonValue[]
  | { readonly [key: string]: AmlJsonValue };

interface AgentHostTool {
  kind: "host";
  name: string;
}

interface AgentJavaScriptTool {
  description: string;
  execute(
    input: unknown,
    context: AgentToolExecutionContext,
  ): Promise<AmlJsonValue>;
  inputSchema: Readonly<Record<string, unknown>>;
  kind: "javascript";
  name: string;
}

type AgentTool = AgentHostTool | AgentJavaScriptTool;

interface AgentToolExecutionContext {
  signal: AbortSignal;
  trace: AmlTraceIdentity;
}

interface AmlTool extends AgentJavaScriptTool {
  // Nominal SDK brand: authored through defineTool(), not implemented structurally.
}
```

Tool names and JavaScript Tool descriptions must be non-empty strings equal to their trimmed forms. AML never silently normalizes either value. A provider whose native tool protocol requires an object-root input schema must reject an incompatible Tool before opening the Agent session.

### 8.1 Host tools

```tsx
<Agent>
  <Tool name="read" />
  <Tool name="grep" />
  Inspect the authentication flow.
</Agent>
```

A named Tool refers to a capability owned by the selected provider or agent host. The adapter must reject names it cannot safely map.

### 8.2 JavaScript tools

`defineTool()` exposes an in-process JavaScript function:

```tsx
const lookupCustomer = defineTool({
  name: "lookup_customer",
  description: "Look up one customer",
  input: z.object({ id: z.number() }),
  async execute({ id }) {
    return database.customers.find(id)
  },
  output: Customer,
})

<Agent>
  <Tool use={lookupCustomer} />
  Look up customer 42.
</Agent>
```

The input schema must satisfy both Standard Schema and Standard JSON Schema. `defineTool()` generates draft 2020-12 input JSON Schema synchronously, validates the returned JSON value, and freezes a stable snapshot. `AmlTool` has a non-enumerable authoring brand, while runtime authenticity uses a package-global exact-identity registry that maps the original `defineTool()` result to an SDK-owned execution port. `<Tool use>` rejects structurally similar objects, clones, derived objects, and forwarding proxies so replaced public members cannot bypass validation. The registry remains interoperable across physical copies of the same SDK package in one JavaScript realm. AML validates every call before the authored `execute()` runs and gives only that generated JSON Schema to the Agent provider. An optional Standard Schema output contract validates and may transform the function result.

Every successful result must be a string or stable JSON data even without an output schema. AML rejects:

- `undefined`
- BigInts and non-finite numbers
- functions and symbols
- class instances
- Maps and Sets
- cyclic values

Snapshotting is stack-safe for deeply nested valid JSON and preserves own string keys such as `__proto__` as data without changing the result object's prototype.

The tool may be asynchronous. It may capture request context, repositories, or session identity through a closure:

```tsx
function SupportAgent() {
  const session = useContext(SessionContext);
  const getOrders = defineTool({
    name: "get_current_user_orders",
    description: "Load orders for the current user.",
    input: z.object({}),
    execute: () => session.database.orders.findByUser(session.userId),
  });

  return (
    <Agent>
      <Tool use={getOrders} />
      Review this user's orders.
    </Agent>
  );
}
```

### 8.3 Capability scope

Every Agent declares its own Tools. Tools are not inherited from parent Agents. This makes each Agent a capability boundary.

`AmlRuntimeOptions.allowedTools` may further restrict both host and JavaScript Tool names:

```tsx
const runtime = new AmlRuntime({
  agentProvider: provider,
  allowedTools: ["read", "lookup_customer"],
});
```

An undeclared name fails before the Agent executes. When the allowlist is omitted, AML adds no runtime name restriction.

A Tool outside an Agent is invalid. Duplicate names in one Agent are invalid. Trusted JavaScript tools execute in the AML host process; `<Sandbox>` does not automatically confine arbitrary host functions.

### 8.4 Transport input normalization

The declared input schema remains authoritative. Every provider transport uses this exact algorithm:

1. If the received value satisfies the schema, preserve it unchanged.
2. If input is omitted, use `{}` only when `{}` satisfies the schema.
3. If a rejected value is a string, parse it as JSON exactly once.
4. Accept the decoded value only if it satisfies the schema.
5. Otherwise throw `ToolInputError` before application code runs.

A string accepted by a string schema is never decoded, even if it resembles JSON. AML does not coerce scalars or recursively parse encoded values.

## 9. `<Mcp>` servers

`<Mcp>` grants one MCP server to one Agent session. It is a capability descriptor, contributes no prompt text, and is never contacted during ordinary child resolution.

```tsx
const projectMcp = defineMcpServer({
  name: "project",
  transport: {
    type: "stdio",
    command: "node",
    args: ["./servers/project.mjs"],
  },
});

<Agent>
  <Mcp name="github" />
  <Mcp use={projectMcp} />
  Investigate the reported issue.
</Agent>;
```

Props:

```ts
type McpProps =
  | { name: string; use?: never }
  | { name?: never; use: AmlMcpServer };
```

A named MCP server refers to configuration owned by the selected Agent provider or its native host. The adapter must reject a name it cannot attach. This makes existing provider-native MCP configuration available without copying credentials or vendor configuration into AML.

`defineMcpServer()` defines an explicit standard transport:

```ts
type AmlMcpTransport =
  | {
      type: "stdio";
      command: string;
      args?: readonly string[];
      cwd?: string;
      env?: Readonly<Record<string, string>>;
    }
  | {
      type: "streamable-http";
      url: string | URL;
      headers?: Readonly<Record<string, string>>;
    };

interface AmlMcpServer {
  readonly name: string;
  readonly transport: AmlMcpTransport;
}

type AgentMcpServer =
  | { kind: "named"; name: string }
  | { kind: "configured"; server: AmlMcpServer };
```

`defineMcpServer()` is synchronous and performs no I/O. It requires a non-empty server name, requires a non-empty `stdio` command or an HTTP(S) Streamable HTTP URL, validates transport fields, and freezes the descriptor. The Agent provider remains the MCP client: it maps the descriptor to its native configuration, launches or connects to the server, performs MCP initialization, exposes supported server capabilities to the Agent session, and owns shutdown.

The transport names follow the MCP specification. With `stdio`, the client launches and terminates the server process. With Streamable HTTP, the client connects to one independent HTTP endpoint. Provider-specific and custom transports are outside the portable descriptor; a provider-native named server may still use them.

### 9.1 Scope and lifecycle

MCP grants are Agent-wide:

- `<Mcp>` is valid only as an Agent capability after component and Fragment expansion.
- MCP servers are not inherited by child or parent Agents.
- Duplicate server names in one Agent are invalid.
- `<Mcp>` inside `<FollowUp>` is invalid because capabilities cannot change between turns.
- The adapter attaches every declared server before the first Agent turn.
- The same connections remain available through all FollowUps.
- The adapter disconnects and terminates invocation-owned servers after success, failure, or cancellation.
- Attachment or initialization failure rejects the Agent before its first turn.
- `AmlRuntimeOptions.allowedMcpServers` may restrict grants by server name.

The adapter must fail closed when it cannot attach a declared server or transport. Provider traces must distinguish provider-native named servers from explicit `stdio` and Streamable HTTP descriptors and must not capture environment values, headers, credentials, or authorization tokens.

MCP servers may expose tools, resources, prompts, and other protocol capabilities. AML does not flatten those into `<Tool>` descriptors or claim that every Agent harness exposes every MCP capability identically. The adapter reports relevant capability differences and preserves the native harness behavior.

Declared MCP servers are the portable AML grant set. If a provider harness also inherits MCP servers from host configuration and cannot disable them, the adapter must report those inherited capabilities and must not claim a clean capability profile.

### 9.2 Sandbox boundary

An MCP grant is an explicit capability outside the portable filesystem contract. `<Sandbox>` confines only the behavior that its Sandbox and Agent providers jointly claim to enforce.

A `stdio` MCP server may run in the provider environment or inside the active Sandbox according to adapter support. A remote Streamable HTTP server necessarily acts outside the local Sandbox. An adapter must not imply that MCP actions are sandbox-confined unless it actually launches or connects them through the Sandbox lease. Applications requiring strict confinement must grant only MCP servers whose execution and authority satisfy that policy.

## 10. `evaluate()` and structured data

`AmlModelSchema<T>` is AML's structural contract for a schema that supports both Standard Schema validation and Standard JSON Schema generation. AML does not require one concrete schema library.

`evaluate()` executes AML as component-local data:

```tsx
async function Workflow() {
  const research = await evaluate(
    <Agent>
      <Tool name="read" />
      Research the customer.
    </Agent>,
  );

  return <Agent>Make a decision using: {research}</Agent>;
}
```

The returned Promise resolves to text. Supplying a schema that satisfies both Standard Schema and Standard JSON Schema requests and validates structured output. Zod 4 is one compatible authoring choice:

```tsx
const Research = z.object({
  risks: z.array(z.string()),
  summary: z.string(),
});

const research = await evaluate(
  <Agent>Return structured research.</Agent>,
  Research,
);
```

With a schema, the supplied AML must resolve to exactly one Agent, optionally through Fragments, Context Providers, or ordinary function components. The provider receives generated JSON Schema and AML validates the returned unknown value again through Standard Schema.

With FollowUps, the schema applies only to the final turn.

### 10.1 Invocation scope

`evaluate()` is available only while its component invocation is active. Awaited asynchronous work retains access until the component settles. Detached work that calls `evaluate()` afterward throws.

Nested calls share the root evaluation's:

- depth
- Agent-call budget
- concurrency limit
- context
- trace tree
- cancellation and resource scopes

### 10.2 Parallel dataflow

Independent calls may be started together:

```tsx
const [review, audit] = await Promise.all([
  evaluate(<Reviewer />, ReviewResult),
  evaluate(<Auditor />, AuditResult),
]);
```

`maxConcurrentAgents` limits active Agent sessions. `Promise.all()` preserves result array order even when Agents finish out of order.

Use `Promise.allSettled()` only when partial failure is an explicit application decision. AML itself does not silently convert Agent failures into partial results.

## 11. Scoped context

`createContext()` defines an immutable downward-scoped dependency:

```tsx
interface Session {
  database: OrderDatabase;
  userId: string;
}

const SessionContext = createContext<Session>("Session");

function OrderAgent() {
  const session = useContext(SessionContext);
  return <Agent>Review orders for user {session.userId}.</Agent>;
}

await runtime.evaluate(
  <SessionContext.Provider value={requestSession}>
    <OrderAgent />
  </SessionContext.Provider>,
);
```

Context obeys lexical scope:

- descendants read the nearest matching Provider
- nested Providers shadow only their own subtree
- parallel branches receive isolated context maps
- an optional default value supplies a fallback
- missing required context throws a named error
- values are never rendered or serialized implicitly

Context is not reactive state. It has no setter, subscription, invalidation, or re-render behavior. Use it for request identity, repositories, policy objects, sandbox handles, configuration, and trace baggage.

Tools should capture scoped dependencies while the component is active. This provides session-based tools without mutable globals.

## 12. `<Loop>` and staged state

`<Loop>` repeats fresh Agent sessions over immutable, schema-validated state snapshots:

```tsx
const ResearchState = z.object({
  pending: z.array(z.string()),
  findings: z.array(z.string()),
  done: z.boolean(),
})

<Loop
  initial={{
    pending: ["authentication"],
    findings: [],
    done: false,
  }}
  name="research"
  schema={ResearchState}
  render={({ iteration, state }) => (
    <Agent>
      {state.done
        ? `Produce the final report from: ${JSON.stringify(state.findings)}`
        : `Iteration ${iteration}. Investigate one item from:
           ${JSON.stringify(state.pending)}. Update the research state.`}
    </Agent>
  )}
/>
```

Props:

```ts
interface LoopProps<State extends Record<string, unknown>> {
  initial: State;
  name?: string;
  render(context: {
    iteration: number;
    state: DeepReadonly<State>;
  }): AmlRenderable;
  schema: StandardSchemaV1<unknown, State>;
}
```

The render result must resolve to exactly one Agent, optionally through a Fragment, Context Provider, or function component. AML automatically grants only that Agent an `aml_set_state` Tool:

```ts
{
  updates: Record<string, unknown>;
}
```

### 12.1 Transactional iteration

One iteration:

1. validates, clones, and deeply freezes the current snapshot
2. invokes `render()` with that snapshot
3. starts one fresh Agent session
4. stages valid `aml_set_state` patches privately
5. lets the Agent finish against the original snapshot
6. returns the Agent text if staged state equals the snapshot
7. otherwise discards the Agent text, commits state atomically, and repeats

Every patch key must exist in the initial state. AML merges a patch and validates the complete object once. Coupled fields should be updated in one call so schema refinements observe one atomic proposal. Invalid patches leave staged state unchanged.

State changes never re-evaluate the currently running Agent tree. No ancestor or sibling rerenders, and AML has no dependency-subscription graph.

If FollowUps appear in the Loop's Agent, state remains staged for the complete multi-turn session. The next FollowUp sees provider history and external effects but not a newly rendered snapshot. Commit happens only after the final FollowUp.

### 12.2 Termination

Loop termination is based on state stability, not a literal boolean condition:

- changed state commits and starts another iteration
- unchanged state returns the current Agent text

A conventional `done` field is authored state, not special AML syntax. The `done` branch normally asks the Agent to summarize without changing state.

This rule is intentionally narrow but somewhat implicit. Future revisions may adopt a more explicit completion result if real workflows show that stability is too magical.

### 12.3 When Loop is appropriate

FollowUp is better for a fixed conversational sequence. Loop is useful when:

- the number of iterations is unknown
- progress must be typed and host-visible
- each iteration should start with fresh provider context
- prompts or capabilities change from the new snapshot
- a runtime transition budget must bound convergence
- the workflow resembles research-frontier processing or plan-implement-test-repair

An ordinary TypeScript `while` loop plus `evaluate()` can express the same general control flow. Loop earns its primitive status through its scoped state Tool, schema validation, immutable snapshots, atomic commit, tracing, and transition budget.

### 12.4 State values and limits

Loop state must be stable JSON:

- finite numbers
- strings and booleans
- null
- arrays
- plain objects with enumerable string keys

Dates, Maps, Sets, class instances, BigInts, functions, undefined values, symbols, cycles, and schemas that transform differently on repeated parsing are rejected.

The state Tool expires when its Agent finishes. Providers must complete or cancel outstanding Tool calls before resolving the Agent.

`maxStateTransitions` counts successful commits across the complete evaluation.

## 13. `<Sandbox>`

`<Sandbox>` scopes an ephemeral execution environment:

```tsx
<Sandbox
  provider={remoteSandbox}
  root="."
  cwd="packages/api"
  access="read-write"
>
  <Agent>Implement and test the API change.</Agent>
</Sandbox>
```

A Sandbox supplies descendants with:

- an execution-environment identity and lifecycle
- one filesystem root they cannot escape
- a default working directory inside that root
- `"read-only"` or `"read-write"` access
- provider-owned command and filesystem capabilities

The outermost Sandbox acquires one Sandbox lease before evaluating its children and releases it after the complete subtree settles. Parallel descendants share that lease and filesystem, so writable Agents may observe or race with one another.

A provider may be supplied directly or configured once on the runtime:

```tsx
const runtime = new AmlRuntime({
  agentProvider,
  sandboxProvider: remoteSandbox,
});

await runtime.evaluate(
  <Sandbox root="repository">
    <Agent>Inspect the repository.</Agent>
  </Sandbox>,
);
```

An outermost Sandbox without either provider is invalid. Its access defaults to `"read-only"`; `root` and `cwd` default to `"."`.

Every descendant Agent inherits the nearest Sandbox. An Agent may narrow its working directory to a child path:

```tsx
<Sandbox root="." cwd=".">
  <Agent cwd="packages/web">Review the web package.</Agent>
  <Agent cwd="packages/api">Review the API package.</Agent>
</Sandbox>
```

Normalized roots and working directories must remain inside the effective parent root. AML rejects empty paths, absolute POSIX or Windows paths, backslashes, and lexical parent traversal. The Sandbox provider must enforce the declared root against real filesystem paths and symlinks; lexical normalization alone is not a security boundary.

### 13.1 Nested Sandboxes

A nested Sandbox is a restrictive view of the same Sandbox lease:

```tsx
<Sandbox root="." access="read-write">
  <Sandbox root="packages/api" access="read-only">
    <Agent>Audit the API without changing it.</Agent>
  </Sandbox>
</Sandbox>
```

A nested Sandbox:

- inherits the parent's provider, lease, disk, and running environment
- may narrow the accessible root
- may select a working directory within that root
- may reduce read-write access to read-only
- may not widen scope or permissions
- may not select another provider

Therefore a write Sandbox inside a read-only Sandbox is invalid.

Independent child environments, copy-on-write forks, and provider changes are different explicit operations. Nesting must not acquire infrastructure implicitly.

### 13.2 Provider enforcement

The selected Agent adapter must explicitly support the effective Sandbox session. If it cannot attach its model-controlled actions to that environment, evaluation fails. AML must never silently fall back to unrestricted host execution.

The model may be remote while its filesystem and Tool execution occur in the current Sandbox. Model location and execution-environment location are separate concerns.

Trusted `defineTool()` functions run in the AML process unless they explicitly use Sandbox-scoped capabilities. JSX placement alone cannot confine arbitrary JavaScript.

### 13.3 Provider and lease contract

AML owns acquisition and release. The provider owns the real environment:

```ts
interface SandboxProvider<Handle = unknown> {
  readonly name: string;
  acquire(request: SandboxAcquireRequest): Promise<SandboxLease<Handle>>;
}

interface SandboxAcquireRequest {
  access: "read-only" | "read-write";
  cwd: string;
  evaluationId: string;
  root: string;
  signal: AbortSignal;
  workspace?: WorkspaceMaterializationReference;
}

interface SandboxLease<Handle = unknown> {
  handle: Handle;
  id: string;
  release(): Promise<void>;
}

interface SandboxSession<Handle = unknown> {
  access: "read-only" | "read-write";
  cwd: string;
  lease: {
    handle: Handle;
    id: string;
  };
  nested: boolean;
  provider: {
    name: string;
  };
  root: string;
}

interface WorkspaceMaterializationReference<Handle = unknown> {
  directory: string;
  handle: Handle;
  leaseId: string;
  provider: {
    name: string;
  };
  workspaceId: string;
}
```

AML:

1. validates the declared root policy
2. emits `sandbox.start`
3. acquires exactly one lease for an outermost Sandbox
4. exposes the effective session to compatible descendant Agents
5. evaluates the complete subtree
6. releases the lease after success or failure
7. emits `sandbox.end` or `sandbox.error`

Nested Sandboxes emit their own spans but do not acquire or release another lease. If subtree evaluation and release both fail, AML rejects with an `AggregateError` that preserves both errors.

`SandboxLease.handle` is deliberately opaque. Agent adapters and Sandbox-specific capabilities agree on its concrete type outside the AML language. AML does not invent a universal process, filesystem, or command API.

Descendants receive only the immutable lease identity and handle shown by `SandboxSession`; they never receive `release()` or the provider's `acquire()` method. AML retains both lifecycle capabilities privately because it alone owns acquisition and exactly-once release. The captured provider name is descriptive identity, not an authority-bearing provider object.

The acquisition signal belongs to the complete evaluation domain. A cooperative provider stops pending setup and rejects with `signal.reason` when it is aborted. If a provider ignores cancellation and eventually returns a valid lease, AML captures the lease and releases it before rejecting the evaluation with the caller's cancellation reason.

When an outer Sandbox is inside a Workspace, `workspace` carries the active immutable materialization reference. Its directory is the provider-neutral shared snapshot; its handle is opaque data for compatible provider-specific transfer or mount optimizations. A Sandbox provider must either attach that materialization or reject acquisition. It must not silently use an unrelated configured directory.

### 13.4 Docker provider requirements

A Node-specific Docker provider uses the configured factory form:

```tsx
import { dockerSandbox } from "@aml/sandbox-docker";

const docker = dockerSandbox({
  buildContext: "./docker",
  dockerfile: "./docker/Dockerfile",
  workspace: approvedHostDirectory,
});

await runtime.evaluate(
  <Sandbox provider={docker} root="repository" access="read-only">
    <Agent>Inspect the repository.</Agent>
  </Sandbox>,
);
```

The factory requires exactly one of `image` or `dockerfile`. Its optional `workspace` is the approved host-directory fallback for a standalone Sandbox. An active `<Workspace>` materialization supersedes that fallback; acquisition rejects if neither exists. `buildContext`, `cpus`, `maxOutputBytes`, `memoryBytes`, `pidsLimit`, `tmpfsBytes`, `user`, and an injected Dockerode client are provider configuration, not AML props. `user` is a numeric non-zero UID with an optional numeric non-zero GID. The injected client must use a local socket, and the Docker daemon must resolve paths in the same filesystem namespace as the AML process. A local socket alone does not prove that condition, so every acquisition creates, mounts, reads, and removes a random identity beneath the exact selected root before exposing the lease. The selected host root must therefore be writable by the AML process during acquisition even when the container receives `"read-only"` access; no probe remains when descendant AML begins. Remote Docker providers require an explicit Workspace transfer or volume contract and are outside this provider.

The configured image must contain POSIX `sh` and `sleep`; the provider replaces its entrypoint with a shell keepalive process for the lease lifetime. Dockerfile builds run with networking disabled. The provider uses Dockerode for Docker Engine transport, container lifecycle, exec streams, BuildKit-aware progress, and image builds; AML-specific code owns only policy translation, real-path confinement, cancellation compensation, output limits, and lease cleanup.

At acquisition the provider:

1. resolves the configured workspace and requested root through the host filesystem
2. rejects roots or working directories whose real paths escape through a symlink
3. mounts only the selected root at `/workspace`
4. proves the daemon sees the same workspace through an ephemeral read-only identity mount
5. makes the workspace bind mount read-only when AML access is `"read-only"`
6. disables networking
7. drops all Linux capabilities and enables `no-new-privileges`
8. runs as a non-root UID
9. makes the container root filesystem read-only with a bounded `/tmp`
10. applies CPU, memory, and PID limits
11. removes the container when the Sandbox lease releases

Container creation is not transport-aborted because an aborted HTTP request cannot prove the Engine abandoned the operation. Cancellation waits for creation to settle and then removes the returned container. If creation fails through an ambiguous transport error, the provider performs documented bounded reconciliation against its preallocated unique name. Finding the resource causes removal. Repeated absence does not prove cleanup, so exhausting reconciliation raises an aggregate cleanup error instead of reporting successful compensation.

The lease handle exposes argument-array `exec()` without a host shell. Every call requires the effective `SandboxSession.cwd`; this prevents an Agent-local `cwd` from silently falling back to the outer lease directory. A compatible Agent adapter can use the handle while keeping model-controlled commands inside the container.

One container cannot enforce a narrower nested filesystem root or downgrade an existing read-write bind mount to read-only merely by changing `cwd`. `supportsDockerSandbox(session)` therefore rejects effective sessions whose root or access differs from the acquired lease. Another adapter may enforce narrowing through constrained tools, an inner process sandbox, or a distinct explicit fork operation; it must not claim enforcement based on working directory alone.

Docker is a useful same-host process/filesystem boundary, not a hostile multi-tenant security guarantee. It shares the host kernel and trusts the local Docker daemon. The provider never mounts the Docker socket.

Docker provider conformance tests must cover read-only and read-write bind behavior, non-root execution, zero effective capabilities, disabled networking, hidden host-sibling paths, read-only container root, persisted read-write changes, and container removal. Real-daemon tests must remain an explicit integration-test target.

## 14. `<Workspace>`

`<Workspace>` owns one durable directory across ephemeral Sandbox runs:

```tsx
<Workspace provider={repositoryWorkspace} id="review-42">
  <Sandbox provider={daytona} access="read-write">
    <Agent>Implement and test the change.</Agent>
  </Sandbox>
</Workspace>
```

Workspace is a top-level resource boundary:

- one evaluation may contain at most one Workspace
- a Workspace cannot be inside a Sandbox
- a Workspace cannot be inside another Workspace
- after a Workspace is established, descendants cannot introduce another
- one Workspace may contain multiple sibling Sandboxes
- sibling root Sandboxes may use different providers

Workspace owns durable identity, locking, materialization, and transfer. Sandbox owns ephemeral execution and confinement.

### 14.1 Lifecycle

One Workspace evaluation:

1. acquires the Workspace and an exclusive writer lease
2. materializes its durable directory as the working snapshot
3. evaluates its subtree
4. attaches and reconciles descendant Sandboxes
5. saves the materialized directory after success or failure
6. releases the lease and temporary materialization
7. returns the child result or rethrows its error

Saving after failure intentionally preserves partial autonomous-agent edits. If saving also fails, AML surfaces the persistence failure without losing the original evaluation failure in traces or error causality.

This is not a crash-safe execution checkpoint. Process or provider failure may lose unsynchronized changes unless the Workspace provider offers continuous or incremental persistence.

### 14.2 Multiple Sandboxes

Sequential Sandboxes operate on one logical working snapshot:

1. a Sandbox receives current Workspace contents
2. its subtree runs
3. changes synchronize into the Workspace snapshot
4. the next Sandbox sees those changes

Shared mounts may avoid copying. Remote providers may upload and download the selected directory. Observable file behavior must remain consistent.

Parallel read-only Sandboxes may use one Workspace revision. The initial runtime must reject conflicting writable attachments; it must not wait indefinitely or silently apply last-writer-wins copies. Higher-level scheduling may serialize complete Workspace evaluations before acquisition, but serialization is not part of the Workspace provider contract.

Workspace providers may use disk, Docker volumes, object storage, Durable Objects, or another durable backend. While one lease is active, another acquisition of the same durable identity must reject with the provider-neutral `WorkspaceConflictError` without returning a lease. Releasing the active lease must make that identity acquirable again. The error carries the stable code `AML_WORKSPACE_CONFLICT` and the conflicting `workspaceId` so duplicated SDK packages can recognize the contract without relying on `instanceof`.

A Sandbox without a Workspace is ephemeral. A Workspace without a Sandbox is durable but makes no confinement claim.

### 14.3 Provider contract

The Workspace provider owns durable storage and exposes one acquired materialization to AML:

```ts
interface WorkspaceProvider<Handle = unknown> {
  readonly name: string;
  acquire(request: WorkspaceAcquireRequest): Promise<WorkspaceLease<Handle>>;
}

interface WorkspaceAcquireRequest {
  evaluationId: string;
  id: string;
  signal: AbortSignal;
}

interface WorkspaceLease<Handle = unknown> {
  directory: string;
  handle: Handle;
  id: string;
  release(): Promise<void>;
  save(): Promise<void>;
}

interface WorkspaceMaterializationReference<Handle = unknown> {
  directory: string;
  handle: Handle;
  leaseId: string;
  provider: {
    name: string;
  };
  workspaceId: string;
}
```

`directory` is the runtime-visible materialization of the durable Workspace. A provider may implement it as a local directory, mounted volume, synchronized remote snapshot, or another filesystem adapter, but descendant Sandboxes must observe the same logical files and ordering guarantees from section 14.2. `save()` persists the current materialization and `release()` relinquishes locks and temporary resources. AML calls both through failure-safe cleanup and preserves multiple failures with causality. `acquire()` must reject a competing writer with `WorkspaceConflictError` while a lease for the same Workspace id remains active; conformance propagates every other provider failure and does not infer locking from timing or provider latency.

After acquisition AML captures an immutable `WorkspaceMaterializationReference` for descendant outer Sandboxes. `workspaceId` is the authored durable identity, `leaseId` is the provider's acquired resource identity, and `provider.name` is descriptive identity rather than acquisition authority. Descendants never receive `save()`, `release()`, or the Workspace provider's `acquire()` method.

`WorkspaceLease.handle` is opaque provider data. It may support optimized transfer or shared-mount integration with a compatible Sandbox provider, but AML does not expose it as a portable filesystem API. A Sandbox provider that cannot attach the reference must reject rather than run against different files.

## 15. Provider contract

### 15.1 Agent-session contract

The provider boundary is:

```ts
interface AmlTraceIdentity {
  parentSpanId?: string;
  runId: string;
  spanId: string;
}

interface AgentProvider {
  readonly name: string;
  run(
    request: AgentRequest,
    context: AgentExecutionContext,
  ): Promise<AgentResponse>;
  supportsSandbox?(sandbox: SandboxSession): boolean;
}

interface AgentRequest {
  followUps?: readonly string[];
  mcpServers: readonly AgentMcpServer[];
  model?: string;
  output?: {
    schema: AmlModelSchema<unknown>;
    type: "json";
  };
  prompt: string;
  system: string;
  tools: readonly AgentTool[];
  trace?: AmlTraceIdentity;
}

interface AgentResponse {
  structured?: unknown;
  text: string;
}

interface AgentExecutionContext {
  signal: AbortSignal;
  sandbox?: SandboxSession;
  trace: AmlTraceIdentity;
}
```

`runId` identifies one `AmlRuntime.evaluate()` call. `spanId` identifies the Agent session within that evaluation, and `parentSpanId` is present when the runtime can attribute the session to an enclosing execution boundary. Trace identities are opaque correlation values; providers must preserve them rather than deriving behavior from their format.

Host Tools contain a name. JavaScript Tools contain a name, description, model-facing input schema, and async execution function. MCP servers contain either a provider-native name or one explicit standard transport descriptor.

An omitted or empty `followUps` array represents a single-input Agent. When FollowUps are present, the adapter:

1. creates one fresh provider session
2. registers Agent-wide Tool and MCP capabilities for its complete lifetime
3. sends `prompt`
4. sends each `followUps` entry after the preceding response
5. applies structured output only to the final input
6. returns only the final response
7. disposes invocation-scoped Tool registrations and MCP connections after the session settles; if the provider cannot remove dynamic registrations, its adapter must use a disposable provider host or reject that capability rather than accumulate registrations in shared provider state

Any failed turn rejects `run()`.

The exact internal adapter class structure is not normative. The observable session, ordering, capability, failure, and output semantics are.

### 15.2 Execution context

The runtime always passes an `AgentExecutionContext`.

When a Sandbox is active, the runtime calls `supportsSandbox(session)` on the provider selected for that Agent. The method must return exactly `true` before the Agent runs. A missing method, `false`, or another value rejects evaluation and the Sandbox lease is still released. This explicit handshake prevents a provider from silently ignoring an execution boundary.

An Agent adapter must not claim compatibility with a Sandbox provider until its model-controlled filesystem, commands, and host tools are attached to the opaque lease.

### 15.3 Provider construction and options

Public provider integrations must use configured factory functions:

```tsx
const sandbox = dockerSandbox({
  dockerfile: "./Dockerfile",
  workspace: repositoryRoot,
});

const workspace = s3Workspace({
  bucket: "agent-workspaces",
  region: "eu-west-1",
});
```

This combines an injected Strategy with an Adapter-specific factory:

- the factory receives and validates backend-specific configuration
- the returned provider is an immutable configured strategy
- the factory is synchronous and performs no resource or network work
- `acquire()` owns asynchronous infrastructure creation
- JSX receives the configured provider through dependency injection

Portable AML props remain on the primitive. For Sandbox those are `root`, `cwd`, and `access`; for Workspace they are durable identity and the authored subtree. Backend addresses, credentials, Dockerfiles, images, buckets, resource limits, and clients belong to provider factories.

AML does not forward arbitrary JSX props to providers, accept an untyped `providerOptions` bag, or resolve string names such as `provider="docker"`. Those shapes weaken type inference, hide dependencies behind a registry, and couple the language to every adapter's option surface.

Applications may construct multiple differently configured providers from the same factory and choose between those instances with ordinary TypeScript.

An Agent selects a configured provider through its `provider` prop or the runtime default:

```tsx
const fast = claudeAgent({ model: "anthropic/claude-haiku-4-5" });
const deep = codexAgent({ reasoningEffort: "high" });

<Agent provider={fast}>Classify the request.</Agent>
<Agent provider={deep} model="gpt-5.3-codex">
  Audit the result.
</Agent>
```

The model prop is the one intentionally portable per-Agent provider override. Other provider-specific options stay type-safe on the configured factory until AML defines a real cross-provider contract for them.

### 15.4 Definition helpers

`@aml/sdk` exports capability and provider definition helpers:

```ts
defineMcpServer(definition);
defineAgentProvider(implementation);
defineSandboxProvider(implementation);
defineWorkspaceProvider(implementation);
```

These helpers are the supported authoring surface for official and third-party adapters. Each helper preserves the implementation's generic types, validates stable provider identity and required lifecycle methods, and returns the corresponding public SDK contract. Provider names must already be non-empty and equal to their trimmed form; helpers reject non-normalized names instead of rewriting a runtime value behind its inferred TypeScript type. They perform no network access, client creation, resource acquisition, global registration, or vendor-option interpretation.

A configured provider's identity and invocation method are captured when it enters its runtime or Agent boundary. AML does not repeatedly read those members while resolving or executing the same Agent.

Official provider packages use the same public helpers available to application authors:

```ts
import { defineAgentProvider, type AgentProvider } from "@aml/sdk";

export interface OpenCodeAgentOptions {
  model?: string;
  // OpenCode-specific configuration remains owned by this package.
}

export function opencodeAgent(options: OpenCodeAgentOptions): AgentProvider {
  return defineAgentProvider({
    name: "opencode",
    async run(request, context) {
      // Create or reuse OpenCode resources only when this call needs them.
      return runOpenCode(options, request, context);
    },
  });
}
```

The provider package's configured factory owns vendor-specific options and returns an immutable adapter. The `define*Provider()` helper owns only the shared contract boundary. In design-pattern terms this is Ports and Adapters combined with configured factories and typed definition helpers; there is no service locator or global provider registry.

`defineMcpServer()` validates and freezes an MCP server identity and explicit standard transport descriptor. It does not start a process, connect to a URL, initialize an MCP client, or register global state.

The SDK provider interfaces remain public and structurally implementable. Direct implementations are allowed, but they must satisfy the same contract and conformance suite. The provider definition helpers are the canonical path because they preserve inference and make runtime validation consistent; official packages must use them.

AML does not expose a generic `defineProvider()`. Agent, Sandbox, and Workspace providers have different lifecycles and capability contracts, so one generic helper would erase useful constraints. AML also does not expose `defineWorkspace()`: `<Workspace>` is the authored resource primitive, while `defineWorkspaceProvider()` authors its backend implementation.

`defineAgent()` is not currently normative. An ordinary async function component already defines a reusable Agent composition. The name may be introduced only if a future Agent definition owns distinct runtime semantics that a component and `defineAgentProvider()` do not express.

## 16. Runtime, limits, and observability

```tsx
const runtime = new AmlRuntime({
  agentProvider: provider,
  allowedMcpServers: ["github", "project"],
  allowedTools: ["read", "lookup_customer"],
  cwd: import.meta.dirname,
  maxAgentCalls: 32,
  maxConcurrentAgents: 4,
  maxDepth: 16,
  maxStateTransitions: 16,
  maxTurnsPerAgent: 16,
  onTraceError(error, event) {
    console.error("Trace sink failed", event.type, error);
  },
  system: "Global application instructions.",
  trace,
});
```

Defaults:

| Option | Default | Meaning |
| --- | --: | --- |
| `agentProvider` | none | Default provider for Agents without a `provider` prop |
| `maxAgentCalls` | `32` | Maximum Agent sessions in one evaluation |
| `maxConcurrentAgents` | `4` | Maximum active Agent sessions |
| `maxDepth` | `16` | Maximum recursive AML evaluation depth |
| `maxStateTransitions` | `16` | Maximum committed Loop transitions |
| `maxTurnsPerAgent` | `16` | Maximum authored inputs in one Agent session |
| `onTraceError` | stderr once | Out-of-band trace failure handler |
| `allowedMcpServers` | unrestricted | Optional MCP-server-name allowlist |
| `allowedTools` | unrestricted | Optional Tool-name allowlist |
| `cwd` | `process.cwd()` | Base directory for relative local Skill files |
| `system` | empty | First system fragment for every Agent |
| `trace` | none | Synchronous execution-event callback |

For every `max*` option, `0` means unlimited. Supplied values must be non-negative safe integers.

One multi-turn Agent counts as one Agent session, not one call per FollowUp. Every initial prompt and FollowUp counts toward `maxTurnsPerAgent`. Provider-internal model/tool loops do not increment either authored limit.

`runtime.evaluate()` returns a string. A text-only tree does not require an Agent provider. An Agent without a local or runtime-default provider rejects. Invalid placement, invalid values, provider errors, schema errors, missing resources, and exceeded limits reject.

### 16.1 Trace contract

The trace sink receives typed events for:

- evaluation start, completion, and failure
- component start, completion, and failure
- Agent session start, completion, and failure
- Agent turns and their ordering
- System resolution and fragment ordering
- Skill file/inline resolution and optional labels
- JavaScript Tool start, completion, and failure
- MCP attachment, initialization, capability summary, disconnection, and failure
- committed Loop transitions
- Sandbox acquisition, nested scope, release, and failure
- provider-specific session and usage events
- Workspace acquisition, materialization, save, release, and failure

Every AML event includes `runId` and `spanId`; nested events include `parentSpanId`. Completion and failure reuse the start span.

Agent session numbers are allocated after post-order descendants resolve, when their sessions are scheduled. FollowUps remain inside the same Agent span. Turn indices are one-based: the initial prompt is turn `1`, and the first FollowUp is turn `2`.

Provider reasoning is not part of AML's stable trace contract.

Trace sinks are synchronous and must return `void`. Their errors cannot change workflow behavior. `onTraceError(error, event)` receives failures through an isolated secondary channel; otherwise AML emits one compact stderr warning. Errors from the secondary handler are swallowed.

Prompts, Skill contents, Tool input/output, MCP configuration, filesystem paths, and model output may be sensitive.

`createConsoleTracer()` provides human-readable output. `createOpenTelemetryTraceSink()` maps the same event tree to OpenTelemetry spans. Content is omitted by default; `captureContent: true` explicitly opts into sensitive prompt and output attributes.

### 16.2 Agent adapter requirements

#### OpenCode

The package exports:

```ts
interface OpenCodeAgentOptions {
  directory?: string;
  model?: string;
  server?: {
    hostname?: string;
    port?: number;
    timeout?: number;
  };
  sessionClient?: OpenCodeSessionClient;
}

interface OpenCodeAgentProvider extends AgentProvider {
  close(): Promise<void>;
}

function opencodeAgent(
  options?: OpenCodeAgentOptions,
): OpenCodeAgentProvider;
```

`opencodeAgent()` is synchronous and performs no I/O. When `sessionClient` is supplied, the package uses that injected provider-owned port and does not start or stop an OpenCode server; that port owns complete Tool attachment and registration cleanup. `sessionClient` and `server` are mutually exclusive. Without `sessionClient`, the first Agent call that has no JavaScript Tool lazily starts one reusable package-owned local OpenCode server using the optional server settings. An Agent with a JavaScript Tool uses a disposable package-owned OpenCode server because OpenCode can disconnect but cannot remove a dynamically added MCP configuration from a long-lived server. Every disposable server requests port `0` so it cannot collide with the reusable server or another concurrent Tool invocation; an explicit `server.port` configures only the reusable host. Other server settings still apply. The disposable server is closed after the complete Agent session and Tool cleanup settle, so registrations cannot accumulate across calls. `close()` is idempotent, rejects future calls, waits for active calls, and stops only the reusable server owned by that provider instance. Concurrent and later callers receive the same cleanup promise and therefore observe the same completion or failure. Credentials remain in the OpenCode environment and configuration; AML does not read or copy them.

`directory` selects the OpenCode working directory. `model` is the configured default and is overridden by `<Agent model>`. Explicit model identifiers use `provider/model` form and are validated before the session is created.

The OpenCode adapter:

- creates one fresh OpenCode session per Agent
- deletes the invocation session after success, failure, or cancellation whenever session creation returned its identifier
- forwards the evaluation `AbortSignal` to session creation and prompting and requests session abort when it fires
- disables all tools before enabling declared Tools
- maps named Tools to host capabilities
- exposes JavaScript Tools through one invocation-scoped localhost MCP bridge
- attaches declared provider-native and explicit MCP servers for the complete OpenCode session
- supports native structured output where available
- uses a JSON-only prompt fallback for `opencode-go`
- filters private reasoning from AML traces
- records session events, visible response parts, tokens, and cost

In the text-only delivery slice, all tools are disabled and no capability is enabled. The returned AML text concatenates only visible OpenCode text parts in response order; synthetic, ignored, tool, reasoning, and lifecycle parts do not contribute.

OpenCode assigns session identifiers server-side. If session creation commits remotely but the request is cancelled before its response returns, the adapter has no identifier with which to abort or delete that unacknowledged session. This is an OpenCode API boundary rather than a recoverable local cleanup path.

OpenCode owns its internal tool loop.

#### Codex

The Codex adapter:

- creates one fresh Codex thread per Agent
- maps AML system text to developer instructions
- defaults to read-only, approval `never`, disabled web search, and disabled Codex subagents
- exposes JavaScript Tools through an invocation-scoped MCP bridge
- attaches declared provider-native and explicit MCP servers for the complete Codex thread
- uses Codex JSON Schema output
- traces thread events and usage
- maps logical `read`, `grep`, and `glob` to the same read-only shell boundary

The Codex adapter must report applicable inherited host configuration such as `AGENTS.md`, skills, plugins, and configured MCP servers. Provider-specific configuration overrides must remain visible; AML must not imply that the session has an empty profile when it cannot guarantee one.

## 17. Futurology

This section records valuable ideas without making them stable contracts.

### 17.1 Agent as tool

`defineAgentTool()` would expose an AML subtree as a model-callable Tool. The concept is useful for model-chosen delegation, but it is outside the normative AML surface.

Agent-as-tool crosses unresolved boundaries:

- a parent provider may hold the only Agent semaphore permit while waiting for a child Agent, causing deadlock
- provider callbacks must support re-entrant Agent execution
- cancellation must cross provider, Tool, and child boundaries
- depth, cost, and call budgets must remain linked
- Tool and credential capabilities must not be inherited implicitly
- Sandbox and Workspace ownership must not be bypassed
- recursive Agent tools can create uncontrolled fan-out

If revisited, the conservative default should be:

- a fresh child Agent session
- the same evaluation domain
- the same Workspace
- the same Sandbox lease, optionally narrowed
- no new Workspace or Sandbox acquisition
- no inherited Tool grants
- parent-owned budgets and cancellation
- scheduler support that cannot deadlock

Truly independent forked execution would be a separate explicit capability with copy-on-write or snapshot semantics, hard budgets, explicit merge/result behavior, and no automatic recursive fork grant.

Until those contracts are proven, deterministic child `<Agent>` composition is the supported multi-agent mechanism.

### 17.2 Dynamic conversations

FollowUp is intentionally static. A future conversation/session API might allow application code to:

- inspect an intermediate response
- validate it
- choose the next message
- retain the same provider session
- stop early

That API would be an imperative asynchronous boundary, not nested FollowUps or component rerendering.

### 17.3 Additional deferred systems

AML does not specify:

- model-produced AML execution
- implicit recursion
- automatic retries
- error boundaries
- durable execution checkpoints or resume
- distributed scheduling
- shared mutable state across parallel branches
- provider-independent streaming
- Tool rollback
- Workspace merge algorithms
- independent nested Sandbox acquisition
- installation or execution of remote Skill bundles

These are product and runtime decisions, not missing tags to add by default.

## 18. Complete example

```tsx
const Finding = z.object({
  file: z.string(),
  problem: z.string(),
});

const Session = createContext<ReviewSession>("ReviewSession");

function Reviewer() {
  const session = useContext(Session);
  const loadPatch = defineTool({
    name: "load_patch",
    description: "Load the patch for this review session.",
    input: z.object({}),
    execute: () => session.repository.loadPatch(),
  });

  return (
    <Agent>
      <Tool use={loadPatch} />
      <Skill src="./skills/evidence.md" />
      Review the patch and identify the highest-risk finding.
      <FollowUp>
        Challenge that finding against the surrounding implementation.
      </FollowUp>
      <FollowUp>Return the final finding as structured output.</FollowUp>
    </Agent>
  );
}

async function ReviewWorkflow() {
  const [finding, architecture] = await Promise.all([
    evaluate(<Reviewer />, Finding),
    evaluate(
      <Agent>
        <Tool name="read" />
        Describe the architecture affected by this patch.
      </Agent>,
    ),
  ]);

  return (
    <Agent>
      Synthesize the review. Finding: {JSON.stringify(finding)}
      Architecture: {architecture}
    </Agent>
  );
}

const runtime = new AmlRuntime({
  agentProvider: provider,
  allowedTools: ["load_patch", "read"],
  trace: createConsoleTracer(),
});

const output = await runtime.evaluate(
  <Session.Provider value={reviewSession}>
    <Workspace provider={workspace} id={reviewSession.id}>
      <Sandbox provider={sandbox} access="read-only">
        <ReviewWorkflow />
      </Sandbox>
    </Workspace>
  </Session.Provider>,
);
```

This example combines Sandbox confinement with durable Workspace lifecycle.
