# Agent Markup Language specification

Status: living normative desired state

Implementation language: TypeScript with JSX

This document is the source of truth for Agent Markup Language (AML). Every unqualified rule describes required behavior, regardless of current implementation status. Contract changes begin here before the implementation roadmap changes.

Product goals, architecture, phase planning, and implementation status live in [PRD.md](./PRD.md). Tests provide executable implementation evidence. Only sections explicitly labelled non-normative or Futurology are outside the required contract.

## 1. What AML is

AML is a TypeScript-embedded DSL and asynchronous runtime for coordinating agents, tools, context, and execution resources with JSX.

AML is:

- an SDK used from ordinary TypeScript
- an orchestration layer over coding-agent harnesses through the Agent Client Protocol (ACP)
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
})
const result = await runtime.evaluate(<Application />)
console.log(result)
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

An AML tree may coordinate Agents backed by different harnesses. ACP is the canonical protocol between AML and every built-in coding-agent harness. AML owns one shared ACP client and session lifecycle; each built-in Agent provider is a thin profile that selects an ACP executable and maps the portable AML request to that Agent's supported ACP configuration.

The same boundary applies whether the Agent process runs on the trusted local host or inside an active Sandbox. Local execution uses a local process launcher; sandboxed execution uses `SandboxRuntime.spawn()`. Local execution is not a second SDK or CLI lifecycle.

Each harness keeps its native:

- model and credentials
- conversation implementation
- internal model/tool loop
- native coding capabilities
- token and usage accounting
- provider-specific events

AML standardizes session creation, authored turns, MCP attachment, streaming, cancellation, and cleanup through ACP. It does not pretend the providers have identical controls: model selection, system instructions, native permission policy, and other settings remain profile mappings where ACP has no portable field.

`AgentProvider` remains a structural public extension point above ACP. Deterministic test providers and application-specific providers may implement that contract directly. A provider that claims to be a built-in coding-agent integration or claims portable execution inside AML Sandboxes must use the canonical ACP session boundary.

The runtime may supply a default Agent provider, and each Agent may override it with another configured provider instance. `model` is the portable per-Agent provider override. Provider-specific settings remain on the provider's configured factory unless AML later defines a real cross-provider contract for them.

### 1.3 Package boundary

AML is developed as an npm workspace monorepo and distributed as one public package:

```text
@aml-jsx/sdk
```

`@aml-jsx/sdk` owns the JSX runtime, evaluator, primitives, public provider interfaces, provider definition helpers, conformance contracts, and the concrete integrations included in the current release. The package root exports the built-in Agent factories `opencodeAgent()`, `codexAgent()`, `copilotAgent()`, and `piAgent()`; the Sandbox factories `localSandbox()`, `dockerSandbox()`, `daytonaSandbox()`, and `modalSandbox()`; and the durable `localWorkspace()`, `filesystemWorkspace()`, and `s3Workspace()` factories.

The SDK exports both `@aml-jsx/sdk/jsx-runtime` and `@aml-jsx/sdk/jsx-dev-runtime` for TypeScript and Vite's automatic production and development JSX transforms.

Concrete providers remain separate private workspaces so their contracts, tests, and vendor-specific lifecycle code have clear owners. The SDK's Vite build follows those provider source graphs and emits one publishable distribution. Provider source imports the provider-neutral SDK core through build aliases, so the public bundle contains one AML runtime and no dependency on private workspace package names.

Examples and applications consume the built `@aml-jsx/sdk` exports. They must not bypass the public package through workspace source paths or private package names.

An example module exports one default function that returns its AML tree directly. It does not return a runner descriptor, construct or configure `AmlRuntime`, or expose a cleanup callback. The shared runner owns cross-cutting evaluation concerns such as tracing. Agent, Sandbox, and Workspace providers own their resource lifecycles through the runtime contracts below.

AML node and primitive interoperability markers must be copy-stable. The exported JSX node type uses a structural symbol-valued discriminant rather than a copy-local unique-symbol key, so an arbitrary `{ type, props }` object is not renderable while TypeScript code using one physical `@aml-jsx/sdk` copy can compose nodes evaluated by another compatible copy.

Separate provider packages may be considered later if dependency weight or release cadence justifies that public boundary. They are not part of the current package contract.

## 2. Evaluation model

AML has two conceptual phases:

1. **Resolution** turns authored JSX into text and typed runtime descriptors.
2. **Execution** consumes those descriptors at boundaries such as `<Agent>`, `<Loop>`, `<Sandbox>`, and `<Workspace>`.

Not every resolved child becomes prompt text:

- text becomes message content
- `<System>` becomes an Agent system-prompt fragment
- `<Tool>` becomes an Agent-scoped JavaScript capability
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
  return <Agent>Find the customer context.</Agent>
}

const workflow = (
  <Agent>
    <GetContext />
    {"\nDecide what to do next."}
  </Agent>
)
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
const [review, audit] = await Promise.all([evaluate(<Reviewer />, ReviewResult), evaluate(<Auditor />, AuditResult)])
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
  signal?: AbortSignal
}

runtime.evaluate(tree, { signal })
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

| Surface                            | Purpose                                                              | Result                     |
| ---------------------------------- | -------------------------------------------------------------------- | -------------------------- |
| `<Fragment>` / `<>`                | Group authored siblings                                              | Ordered child results      |
| `AmlRuntime`                       | Own one complete evaluation                                          | Final string               |
| `<Agent>`                          | Execute one Agent boundary                                           | Final text                 |
| `<System>`                         | Contribute resolved text to an Agent's system prompt                 | System descriptor          |
| `defineAgentProvider()`            | Define an Agent harness adapter                                      | `AgentProvider`            |
| `<Tool>`                           | Grant a JavaScript capability                                        | Tool descriptor            |
| `defineTool()`                     | Expose a JavaScript function to an Agent                             | Tool definition            |
| `<Skill>`                          | Resolve reusable instruction text                                    | Text                       |
| `<File>`                           | Materialize resolved text inside an active Workspace                 | No text                    |
| `<Sandbox>`                        | Scope an ephemeral execution lease and restrictive filesystem policy | Descendant execution scope |
| `defineSandboxProvider()`          | Define an ephemeral execution adapter                                | `SandboxProvider`          |
| `<Script>`                         | Execute an authored command on the host or in an active Sandbox      | Standard output            |
| `<Workspace>`                      | Load and save one durable working directory                          | Descendant filesystem root |
| `defineWorkspaceProvider()`        | Define a durable workspace adapter                                   | `WorkspaceProvider`        |
| `<Mcp>`                            | Grant a provider-native or explicitly configured MCP server          | MCP server descriptor      |
| `defineMcpServer()`                | Define an explicitly configured MCP server grant                     | MCP server definition      |
| `evaluate()`                       | Evaluate AML as component-local data                                 | `Promise<string \| T>`     |
| `<FollowUp>`                       | Stage another input in the same Agent session                        | Turn descriptor            |
| `<Loop>`                           | Repeat fresh Agents over validated state snapshots                   | Final text                 |
| `<Context.Provider>`               | Scope an immutable dependency downward                               | Descendant context         |
| `createContext()` / `useContext()` | Define and read scoped dependencies                                  | Typed value                |

`<Loop>`, `<Context.Provider>`, and `createContext()` / `useContext()` are draft design targets. Their sections remain in this specification so the intended boundaries can be reviewed, but they are not part of the current public reference or release-ready primitive count.

### 3.2 Delivery phases

The normative surface is delivered in phases so the public API grows only after each earlier boundary has deterministic proof.

| Phase                  | Surface                                                        | Purpose                                                                               |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Foundation             | JSX values, Fragments, async components, `AmlRuntime`          | Prove single-invocation asynchronous evaluation                                       |
| MVP 1                  | `<Agent>`, `<System>`, `defineAgentProvider()`                 | Establish the provider-neutral execution and message-channel boundary                 |
| MVP 2                  | `<Tool>`, `defineTool()`                                       | Add scoped JavaScript capabilities                                                    |
| MVP 3                  | `<Skill>`                                                      | Add reusable instruction resolution                                                   |
| MVP 4                  | `<Sandbox>`, `defineSandboxProvider()`                         | Add ephemeral execution scope                                                         |
| MVP 5                  | `<Workspace>`, `defineWorkspaceProvider()`                     | Add durable filesystem scope and complete the MVP                                     |
| Post-MVP capabilities  | `<Mcp>`, `defineMcpServer()`                                   | Attach MCP servers without making the SDK own an Agent harness                        |
| Filesystem composition | `<File>`, `<Script>`                                           | Materialize resolved text and run explicit commands on the host or in resource scopes |
| Post-MVP orchestration | `evaluate()`, structured output, `<FollowUp>`; draft: `<Loop>` | Add richer dataflow and same-session or iterative execution                           |
| Draft late surface     | `createContext()`, `useContext()`, `<Context.Provider>`        | Add immutable dependency scope only after the execution and resource model is stable  |

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
  const customer = await database.customers.find(42)
  return `Customer: ${customer.name}`
}
```

All components are asynchronous computations even when their functions do not use the `async` keyword.

### 4.1 Ordinary async semantics

AML invokes a component exactly once for each evaluated occurrence and awaits its result. Reusing the same JSX value in two authored positions creates two evaluated occurrences; AML does not memoize component results by element identity.

```tsx
async function Workflow() {
  const research = await evaluate(<Agent>Research the customer.</Agent>)

  return <Agent>Decide using: {research}</Agent>
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
  )
}
```

AML does not define `<If>`, `<Else>`, `<Map>`, or `<Sequence>`. Those would duplicate the host language without adding runtime behavior.

## 5. `<Agent>` sessions

An `<Agent>` is one Agent-session boundary. It may contain one initial input and multiple sequential provider turns through `<FollowUp>`.

```tsx
<Agent model="opencode-go/minimax-m3" provider={openCode} system="You are a support operations lead.">
  <System>Prefer concrete operational evidence.</System>
  <Tool use={searchSupport} />
  Investigate customer 42.
</Agent>
```

Props:

```ts
interface AgentProps {
  children?: AmlRenderable
  model?: string
  permissions?: {
    filesystem?: "read-only" | "read-write"
    network?: boolean
    shell?: boolean
  }
  provider?: AgentProvider
  system?: string
}
```

`provider` selects the harness for this Agent. When omitted, AML uses `AmlRuntimeOptions.agentProvider`. An Agent without either provider is invalid. Different Agents in one evaluation may select different providers while remaining in the same evaluation domain.

`model` is a provider-neutral override whose string remains provider-owned. Resolution order is the Agent `model` prop, then the configured provider's default, then the provider-native default. AML passes the explicit prop through `AgentRequest.model`; the selected provider rejects identifiers it cannot use.

`system` is the concise fixed-text system prompt. `<System>` is the composable form for resolved asynchronous content. Provider-specific settings that have no portable AML semantics belong to configured provider instances, not arbitrary Agent props or an untyped `providerOptions` bag.

`permissions` describes the native coding environment requested from the Agent harness. Omitted fields default optimistically to `{ filesystem: "read-write", network: true, shell: true }`: a coding Agent can inspect and edit its Workspace, execute commands, and use the network without repetitive `<Tool>` declarations. A profile maps these portable requests to its native controls and reports any control it cannot express exactly.

Agent permissions are not a security boundary. An enclosing read-only Sandbox narrows the effective Agent filesystem permission to `"read-only"`; other Sandbox network and process policy remains authoritative regardless of the Agent request. A profile must never claim that an Agent-level setting widens the active Sandbox policy.

For built-in coding agents, the selected provider executes this plan through one ACP session:

1. launch the provider profile's ACP Agent through the active Sandbox process launcher or the trusted local launcher
2. initialize ACP and negotiate capabilities
3. create one session at the effective Workspace working directory with every explicit MCP server and AML-owned bridge, while applying profile policy for named native servers
4. apply profile-owned mappings for the selected model, system instructions, and native capability policy
5. send the initial prompt and each FollowUp sequentially through that session
6. cancel through ACP when supported, then terminate the invocation-owned process tree during cleanup
7. close all invocation-owned MCP bridges and process streams before `AgentProvider.run()` settles

ACP session identifiers and protocol events remain provider implementation details. AML exposes only its provider-neutral result, trace, and lifecycle contracts.

### 5.1 Agent plan

AML completely resolves Agent children before opening the provider session. The conceptual result is an Agent plan:

```ts
interface AgentPlan {
  initialPrompt: string
  followUps: readonly string[]
  mcpServers: readonly AgentMcpServer[]
  model?: string
  permissions: AgentPermissions
  system: string
  systemFragments: readonly string[]
  tools: readonly AgentTool[]
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

| State                                  | Visibility in the next FollowUp                               |
| -------------------------------------- | ------------------------------------------------------------- |
| Provider conversation history          | Visible automatically in the same session                     |
| Filesystem, database, and tool effects | Visible if the same resource scope exposes them               |
| AML Loop state                         | Still staged; committed only after the complete Agent session |

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
const classification = await evaluate(<Agent>Classify this defect.</Agent>, Classification)

return classification.kind === "security" ? (
  <Agent>Perform a security review: {classification.summary}</Agent>
) : (
  <Agent>Perform a correctness review: {classification.summary}</Agent>
)
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

Tools are application-defined JavaScript capabilities, not render-time calls and not aliases for an Agent's native Unix tools.

`<Tool>` is a capitalized exported component. AML does not define lowercase HTML-like intrinsic elements.

```ts
interface ToolProps {
  use: AmlTool
}

type AmlJsonValue =
  null | boolean | number | string | readonly AmlJsonValue[] | { readonly [key: string]: AmlJsonValue }

interface AgentJavaScriptTool {
  description: string
  execute(input: unknown, context: AgentToolExecutionContext): Promise<AmlJsonValue>
  inputSchema: Readonly<Record<string, unknown>>
  kind: "javascript"
  name: string
}

type AgentTool = AgentJavaScriptTool

interface AgentToolExecutionContext {
  signal: AbortSignal
  trace: AmlTraceIdentity
}

interface AmlTool extends AgentJavaScriptTool {
  // Nominal SDK brand: authored through defineTool(), not implemented structurally.
}
```

Tool names and descriptions must be non-empty strings equal to their trimmed forms. AML never silently normalizes either value. A provider whose native tool protocol requires an object-root input schema must reject an incompatible Tool before opening the Agent session.

### 8.1 JavaScript tools

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
  const session = useContext(SessionContext)
  const getOrders = defineTool({
    name: "get_current_user_orders",
    description: "Load orders for the current user.",
    input: z.object({}),
    execute: () => session.database.orders.findByUser(session.userId),
  })

  return (
    <Agent>
      <Tool use={getOrders} />
      Review this user's orders.
    </Agent>
  )
}
```

Built-in coding-agent providers expose JavaScript Tools through one AML-owned, invocation-scoped MCP server supplied during ACP session creation. The bridge authenticates calls, applies the transport normalization above, executes the exact registered `defineTool()` capability in the AML host, and closes after the complete Agent session. Agent profiles must not maintain separate vendor-specific JavaScript Tool transports.

### 8.2 Capability scope

Every Agent declares its own Tools. Tools are not inherited from parent Agents. JavaScript Tools are an exact invocation capability set. Native filesystem, shell, and network behavior comes from the Agent's permission request and the enclosing Sandbox, not from `<Tool>`.

`AmlRuntimeOptions.allowedTools` may further restrict JavaScript Tool names:

```tsx
const runtime = new AmlRuntime({
  agentProvider: provider,
  allowedTools: ["lookup_customer"],
})
```

An undeclared name fails before the Agent executes. When the allowlist is omitted, AML adds no runtime name restriction.

A Tool outside an Agent is invalid. Duplicate names in one Agent are invalid. Trusted JavaScript tools execute in the AML host process; `<Sandbox>` does not automatically confine arbitrary host functions.

### 8.3 Transport input normalization

The declared input schema remains authoritative. Before schema validation, AML snapshots every non-omitted provider value once into stable JSON and uses that same snapshot whether content tracing is disabled or enabled. This prevents stateful accessors or proxies from presenting different data to tracing and validation. Invalid transport JSON throws `ToolInputError`; omitted input remains `undefined` for the schema algorithm below.

Every provider transport then uses this exact algorithm:

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
})

;<Agent>
  <Mcp name="github" />
  <Mcp use={projectMcp} />
  Investigate the reported issue.
</Agent>
```

Props:

```ts
type McpProps = { name: string; use?: never } | { name?: never; use: AmlMcpServer }
```

A named MCP server refers to configuration owned by the selected Agent provider or its native host. Provider execution must fail closed when that exact name cannot be attached. An adapter may preflight configuration it can inspect or delegate late-bound resolution to a native host whose ambient configuration is intentionally opaque, but it must not silently omit the authored grant. This makes existing provider-native MCP configuration available without copying credentials or vendor configuration into AML.

`defineMcpServer()` defines an explicit standard transport:

```ts
type AmlMcpTransport =
  | {
      type: "stdio"
      command: string
      args?: readonly string[]
      cwd?: string
      env?: Readonly<Record<string, string>>
    }
  | {
      type: "streamable-http"
      url: string
      headers?: Readonly<Record<string, string>>
    }

type DefineMcpServerOptions = {
  name: string
  transport:
    | AmlMcpTransport
    | (Omit<Extract<AmlMcpTransport, { type: "streamable-http" }>, "url"> & {
        url: string | URL
      })
}

interface AmlMcpServer {
  readonly __amlMcpServer: true
  readonly name: string
  readonly transport: AmlMcpTransport
}

type AgentMcpServer = { kind: "named"; name: string } | { definition: AmlMcpServer; kind: "configured" }
```

`defineMcpServer()` is synchronous and performs no I/O. It requires a non-empty normalized server name, requires a non-empty normalized `stdio` command or an HTTP(S) Streamable HTTP URL, validates every transport field, snapshots arrays and string records, normalizes a URL input to its string form, and freezes the complete descriptor. `<Mcp use>` accepts only the exact identity returned by `defineMcpServer()`, including across physical SDK copies; clones and structurally similar objects are not definitions.

For a built-in coding agent, AML passes every explicit MCP descriptor through ACP `session/new`. Every ACP Agent must support stdio MCP servers; a provider profile must reject a configured transport the Agent does not advertise, including Streamable HTTP when unsupported. A named server remains provider-native configuration: the profile must enable or verify that exact name or fail closed. The ACP Agent becomes the MCP client and owns protocol initialization and native capability exposure. AML owns any process or bridge it created and waits for that resource to close during invocation cleanup.

The transport names follow the MCP specification. With `stdio`, the client launches and terminates the server process. With Streamable HTTP, the client connects to one independent HTTP endpoint. Provider-specific and custom transports are outside the portable descriptor; a provider-native named server may still use them.

### 9.1 Scope and lifecycle

MCP grants are Agent-wide:

- `<Mcp>` is valid only as an Agent capability after component and Fragment expansion.
- MCP servers are not inherited by child or parent Agents.
- Duplicate server names in one Agent are invalid.
- A provider must reject distinct names that collide after its required identifier normalization.
- `<Mcp>` inside `<FollowUp>` is invalid because capabilities cannot change between turns.
- The adapter attaches every declared server before the first Agent turn.
- The same connections remain available through all FollowUps.
- The adapter disconnects and terminates invocation-owned servers after success, failure, or cancellation.
- Attachment or initialization failure rejects the Agent before its first turn.
- `AmlRuntimeOptions.allowedMcpServers` may restrict grants by server name.

The adapter must fail closed when it cannot attach a declared server or transport. Provider traces must distinguish provider-native named servers from explicit `stdio` and Streamable HTTP descriptors and must not capture environment values, headers, credentials, or authorization tokens.

MCP servers may expose tools, resources, prompts, and other protocol capabilities. AML does not flatten those into `<Tool>` descriptors or claim that every Agent harness exposes every MCP capability identically. The adapter reports relevant capability differences and preserves the native harness behavior.

Declared MCP servers are the portable AML grant set. If a provider harness also inherits MCP servers from host configuration and cannot disable them, the adapter must report those inherited capabilities and must not claim a clean capability profile.

When a provider expresses MCP grants through wildcard patterns, its adapter must prove that each generated pattern covers only the declared server. It must reject declared and inherited server names whose provider-normalized namespaces overlap in either direction. An authored grant must never broaden the explicit MCP capability set or select a capability from another source.

### 9.2 Sandbox boundary

An MCP grant is an explicit capability outside the portable filesystem contract. `<Sandbox>` confines only the behavior that its Sandbox and Agent providers jointly claim to enforce.

A `stdio` MCP server may run in the provider environment or inside the active Sandbox according to adapter support. A remote Streamable HTTP server necessarily acts outside the local Sandbox. An adapter must not imply that MCP actions are sandbox-confined unless it actually launches or connects them through the Sandbox lease. Applications requiring strict confinement must grant only MCP servers whose execution and authority satisfy that policy.

## 10. `evaluate()` and structured data

`AmlModelSchema<T>` is AML's structural contract for a schema that supports both Standard Schema validation and Standard JSON Schema generation. AML does not require one concrete schema library.

`evaluate()` executes AML as component-local data:

```tsx
async function Workflow() {
  const research = await evaluate(<Agent>Research the customer.</Agent>)

  return <Agent>Make a decision using: {research}</Agent>
}
```

The returned Promise resolves to text. Supplying a schema that satisfies both Standard Schema and Standard JSON Schema requests and validates structured output. Zod 4 is one compatible authoring choice:

```tsx
const Research = z.object({
  risks: z.array(z.string()),
  summary: z.string(),
})

const research = await evaluate(<Agent>Return structured research.</Agent>, Research)
```

With a schema, the supplied AML must resolve to exactly one Agent, optionally through Fragments, Context Providers, or ordinary function components. Non-empty text outside that Agent is invalid because it would create a second result channel. AML generates and snapshots draft 2020-12 JSON Schema before the provider boundary, sends that portable JSON document through `AgentRequest.output.jsonSchema`, and validates the provider's returned unknown value again through the original Standard Schema. Providers never receive or invoke the application-owned schema object. The component receives Standard Schema's inferred output, including an authored transformation; only the provider-facing value and JSON Schema must remain JSON.

`<Loop>` is invalid anywhere inside a schema-bearing `evaluate()` subtree, including the selected Agent's prompt, System, Skill, and FollowUp channels. A Loop may open multiple fresh Agent sessions and therefore cannot satisfy the structured call's exactly-one-Agent execution contract.

With FollowUps, the schema applies only to the final turn.

Built-in coding-agent providers implement this contract through one AML-owned, invocation-scoped MCP submission Tool supplied during ACP session creation. AML exposes that Tool only for a structured invocation, instructs the Agent profile to submit exactly one final value on the last authored turn, captures the submitted JSON value, and validates it through the original Standard Schema after the provider returns. ACP does not currently define a portable JSON Schema output field, so profiles must not implement separate vendor-native structured-output lifecycles. Missing, duplicate, premature, or invalid submissions reject the Agent.

### 10.1 Invocation scope

`evaluate()` is available only while its component invocation is active. Awaited asynchronous work and a returned custom thenable retain access until AML observes that returned completion value settle. Synchronous components revoke access before their queued microtasks run. For native asynchronous components, JavaScript may run microtasks queued inside the component before AML's settlement reaction; those calls remain part of the active boundary and are joined, so authors must not use them as fire-and-forget work. Calls made after AML observes component settlement throw. Before leaving the component boundary, AML joins nested evaluations that are still active; an early `Promise.all()` rejection therefore cannot release an enclosing Sandbox or Workspace underneath another branch that is still running. Physical copies of the same SDK share the active component binding within one JavaScript realm, so a component and runtime do not lose the boundary merely because a package manager installed duplicate copies.

The component-local capability is masked while AML validates an explicit Agent provider, invokes that provider, captures its response, and validates structured output. Provider callbacks, provider-owned accessors and thenables, schema validation callbacks, and JavaScript Tool callbacks reached through that provider cannot call `evaluate()` re-entrantly. Such a call rejects immediately rather than queuing an Agent behind a scheduler slot held by its own parent or injecting unauthored work into the active domain. Agent-as-Tool and provider-re-entrant Agent execution remain outside the normative model.

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
const [review, audit] = await Promise.all([evaluate(<Reviewer />, ReviewResult), evaluate(<Auditor />, AuditResult)])
```

`maxConcurrentAgents` limits active Agent sessions. `Promise.all()` preserves result array order even when Agents finish out of order.

The scheduler belongs to one evaluation domain. An Agent resolves its authored children, capabilities, Sandbox view, and structured-output contract before requesting a slot. AML reserves its Agent-call budget and then queues the complete provider call in ready order. A slot is held until `AgentProvider.run()` settles, including any provider-owned session and capability cleanup performed before that Promise resolves.

`maxConcurrentAgents: 0` disables the concurrency limit. A positive value is the maximum number of provider calls active in that evaluation; separate root evaluations have separate schedulers. Aborting the evaluation propagates the caller's signal to active providers, rejects queued Agents with the caller's cancellation reason, and prevents those queued providers from starting. One Agent failure does not implicitly abort independent sibling work that the application already started.

Use `Promise.allSettled()` only when partial failure is an explicit application decision. AML itself does not silently convert Agent failures into partial results.

## 11. Scoped context (Draft)

`createContext()` defines an immutable downward-scoped dependency:

```tsx
interface Session {
  database: OrderDatabase
  userId: string
}

const SessionContext = createContext<Session>("Session")

function OrderAgent() {
  const session = useContext(SessionContext)
  return <Agent>Review orders for user {session.userId}.</Agent>
}

await runtime.evaluate(
  <SessionContext.Provider value={requestSession}>
    <OrderAgent />
  </SessionContext.Provider>
)
```

The public contract is:

```ts
interface AmlContext<Value> {
  readonly name: string
  readonly Provider: AmlComponent<ContextProviderProps<Value>>
}

interface ContextProviderProps<Value> {
  readonly children?: AmlRenderable
  readonly value: Value
}

function createContext<Value>(name: string): AmlContext<Value>
function createContext<Value>(name: string, defaultValue: Value): AmlContext<Value>

function useContext<Value>(context: AmlContext<Value>): Value
```

The context name must be a non-empty normalized string and appears in diagnostics. Omitting the second `createContext()` argument creates a required context. Passing a second argument creates a defaulted context, including when that argument is explicitly `undefined`.

Context obeys lexical scope:

- descendants read the nearest matching Provider
- nested Providers shadow only their own subtree
- parallel branches receive isolated context maps
- an optional default value supplies a fallback
- missing required context throws an `EvaluationError` that names the context
- values are never rendered or serialized implicitly

`<Context.Provider>` is a transparent lexical wrapper. It preserves the surrounding text or Agent descriptor channel while changing the binding visible to descendant function components. Its required `value` prop is application data, not AML: the runtime captures the value by identity and does not evaluate, clone, freeze, serialize, trace, or append it. “Immutable” describes the binding, not the provided object. AML exposes no operation that replaces a binding after the Provider is entered; application-owned repositories and clients may still have their own internal mutable state.

`useContext()` is synchronous and valid only while AML is invoking an ordinary function component. It reads the nearest binding active at that component occurrence. Calling it outside component invocation, from provider-owned callbacks, or from detached work after a component settles fails closed. A component-local `evaluate()` inherits the binding map active at the calling component, while Providers created inside that nested tree remain local to that tree.

Context identity is the exact object returned by `createContext()`, not its name. Two contexts with the same name do not share values. Compatible physical copies of `@aml-jsx/sdk` in one JavaScript realm share the context-definition registry and component invocation storage, so a Context authored through one copy can be provided, consumed, and evaluated through another.

Context is not reactive state. It has no setter, subscription, invalidation, re-render, or implicit propagation into later unrelated evaluations. Use it for request identity, repositories, policy objects, configuration, and trace baggage. Sandbox handles remain available through `AgentExecutionContext`; putting one in Context does not change Sandbox ownership or confinement.

Tools should capture scoped dependencies while the component is active. This provides session-based tools without mutable globals.

## 12. `<Loop>` and staged state (Draft)

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
interface LoopProps<Schema extends StandardSchemaV1<unknown, Record<string, unknown>>> {
  initial: StandardSchemaV1.InferInput<Schema>
  name?: string
  render(context: { iteration: number; state: DeepReadonly<StandardSchemaV1.InferOutput<Schema>> }): AmlRenderable
  schema: StandardSchemaV1.InferOutput<Schema> extends StandardSchemaV1.InferInput<Schema> ? Schema : never
}
```

`initial` uses the schema input type while `render()` receives its object output type. Stable defaults and transformations may therefore normalize the initial value before the first immutable snapshot without making authors lie about either shape. The output type must be assignable to the input type because AML validates canonical output again and feeds committed snapshots back through the same schema. For example, an input field typed `string | number` may normalize to `number`; a schema accepting only `string` cannot normalize to `number` because its own canonical output would be invalid on the next validation.

The render result must resolve to exactly one Agent, optionally through a Fragment, Context Provider, or function component. AML automatically grants only that Agent an `aml_set_state` Tool:

```ts
{
  updates: Record<string, unknown>
}
```

The Tool accepts exactly one non-empty `updates` object and returns:

```ts
{
  changed: boolean;
  updated: string[];
  willRepeat: boolean;
}
```

`changed` reports whether this call changed the previously staged snapshot. `willRepeat` reports whether the complete staged snapshot currently differs from the iteration's immutable input. Concurrent calls are serialized in invocation order.

`aml_set_state` is a runtime-owned capability required by Loop rather than an author-selected grant, so `allowedTools` does not remove it. The name remains reserved within the selected Agent: explicitly declaring another Tool named `aml_set_state` is a duplicate-capability error. Child Agents nested inside the selected Agent do not inherit it.

### 12.1 Transactional iteration

One iteration:

1. validates, clones, and deeply freezes the current snapshot
2. invokes `render()` with that snapshot
3. starts one fresh Agent session
4. stages valid `aml_set_state` patches privately
5. lets the Agent finish against the original snapshot
6. returns the Agent text if staged state equals the snapshot
7. otherwise discards the Agent text, commits state atomically, and repeats

Every patch key must exist in the validated initial snapshot. AML merges a patch and validates the complete object as one atomic proposal. Coupled fields should be updated in one call so schema refinements observe one atomic proposal. Invalid patches leave staged state unchanged.

AML validates schema output again after cloning it as JSON. The two normalized values must be deeply equal, which permits stable defaults, stripping, and normalization while rejecting state schemas whose transformations drift on repeated parsing.

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
<Sandbox provider={remoteSandbox} root="." cwd="packages/api" access="read-write">
  <Agent>Implement and test the API change.</Agent>
</Sandbox>
```

A Sandbox supplies descendants with:

- an execution-environment identity and lifecycle
- one logical filesystem root and the provider's stated enforcement level
- a default working directory inside that root
- `"read-only"` or `"read-write"` access
- provider-owned command and filesystem capabilities

The outermost Sandbox acquires one Sandbox lease before evaluating its children and releases it after the complete subtree settles. Parallel descendants share that lease and filesystem, so writable Agents may observe or race with one another.

A provider may be supplied directly or configured once on the runtime:

```tsx
const runtime = new AmlRuntime({
  agentProvider,
  sandboxProvider: remoteSandbox,
})

await runtime.evaluate(
  <Sandbox root="repository">
    <Agent>Inspect the repository.</Agent>
  </Sandbox>
)
```

An outermost Sandbox without either provider is invalid. Its access defaults to `"read-only"`; `root` and `cwd` default to `"."`.

Every descendant Agent inherits the nearest Sandbox. An Agent may narrow its working directory to a child path:

```tsx
<Sandbox root="." cwd=".">
  <Agent cwd="packages/web">Review the web package.</Agent>
  <Agent cwd="packages/api">Review the API package.</Agent>
</Sandbox>
```

Normalized roots and working directories must remain inside the effective parent root. AML rejects empty paths, absolute POSIX or Windows paths, backslashes, and lexical parent traversal. An isolating Sandbox provider must enforce the declared root against real filesystem paths and symlinks; lexical normalization alone is not a security boundary. A provider that intentionally executes on the host must state that it is non-isolating and must not be presented as protection for untrusted commands.

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

The selected built-in Agent profile must be launchable through the effective Sandbox runtime. AML starts its ACP Agent with `SandboxRuntime.spawn()` at the effective Workspace cwd. If the environment does not contain a compatible ACP executable or cannot provide the negotiated session capabilities, evaluation fails. AML must never move the Agent process to the host or fall back to a provider-specific CLI or SDK lifecycle.

The model API may remain remote while the coding-agent process, native filesystem operations, and command execution occur in the current Sandbox. Model location and execution-environment location are separate concerns.

The built-in Codex, GitHub Copilot, OpenCode, and Pi profiles implement `supportsSandbox()` against the same process contract. Compatibility means the Sandbox can spawn that profile's ACP executable and enforce the effective root and access view; it does not imply that every provider-native operation or optional ACP capability is available. Unsupported capabilities must reject before the first prompt rather than fall back to the AML host.

Trusted `defineTool()` functions run in the AML process unless they explicitly use Sandbox-scoped capabilities. JSX placement alone cannot confine arbitrary JavaScript.

### 13.3 Provider and lease contract

AML owns acquisition and release. The provider owns the real environment:

```ts
interface SandboxProvider<Handle = unknown> {
  readonly name: string
  acquire(request: SandboxAcquireRequest): Promise<SandboxLease<Handle>>
}

interface SandboxAcquireRequest {
  access: "read-only" | "read-write"
  cwd: string
  evaluationId: string
  root: string
  signal: AbortSignal
  workspace?: WorkspaceMaterializationReference
}

interface SandboxLease<Handle = unknown> {
  handle: Handle
  id: string
  runtime: SandboxRuntime
  release(): Promise<void>
}

interface SandboxSession<Handle = unknown> {
  access: "read-only" | "read-write"
  cwd: string
  lease: {
    handle: Handle
    id: string
    runtime: SandboxRuntime
  }
  nested: boolean
  provider: {
    name: string
  }
  root: string
}

interface SandboxRuntime {
  access: "read-only" | "read-write"
  cwd: string
  root: string
  exec(
    command: string,
    args?: readonly string[],
    options?: {
      cwd?: string
      env?: Readonly<Record<string, string>>
      signal?: AbortSignal
      timeoutMs?: number
    }
  ): Promise<{
    exitCode: number
    stdout: string
    stderr: string
  }>
  spawn(
    command: string,
    args?: readonly string[],
    options?: {
      cwd?: string
      env?: Readonly<Record<string, string>>
      signal?: AbortSignal
      timeoutMs?: number
    }
  ): Promise<{
    id: string
    stdin: WritableStream<Uint8Array>
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    wait(): Promise<{ exitCode: number }>
    kill(): Promise<void>
  }>
}

interface WorkspaceMaterializationReference<Handle = unknown> {
  cwd: string
  directory: string
  handle: Handle
  leaseId: string
  provider: {
    name: string
  }
  workspaceId: string
  writeConcurrency: "serial" | "parallel"
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

`SandboxLease.handle` remains opaque provider data for Workspace attachment and provider-specific optimization. Built-in Agent profiles use the lease's narrow `SandboxRuntime.spawn()` to launch one long-lived ACP process with an effective logical working directory. Sandboxed `<Script>`, trusted setup, and provider implementation details may use `exec()` for bounded literal commands. Agent turns must not use `exec()` as a second protocol. AML deliberately does not standardize files, images, snapshots, ports, or the union of provider SDK features.

Descendants receive only the immutable lease identity, handle, and runtime shown by `SandboxSession`; they never receive `release()` or the provider's `acquire()` method. AML retains both lifecycle capabilities privately because it alone owns acquisition and exactly-once release. The captured provider name is descriptive identity, not an authority-bearing provider object.

The runtime's `root` and `cwd` use AML's logical Workspace namespace. A provider maps an `exec()` or `spawn()` working directory to its host, container, or remote filesystem. Both methods preserve argument boundaries. `exec()` returns non-zero process exit codes as results; transport failure, cancellation, timeout, and inability to start the command reject. Providers must bound captured `exec()` output.

`spawn()` returns a provider-neutral process handle. `id` is the portable identity because remote backends may expose only a command, exec, or session id rather than an operating-system PID. Input, standard output, and standard error use standard Web streams. Providers begin buffering output before the handle becomes visible. Closing `stdin` requests a pipe EOF when the backend supports one and always prevents later writes through that stream; callers must not depend on remote providers exposing a literal half-close. `wait()` captures one immutable exit result, and both `wait()` and `kill()` are repeatable. Termination targets the spawned process tree rather than only a shell wrapper. Process tracking is scoped to one lease so releasing one evaluation lane cannot terminate another lane's work. `exec()` implementations built over `spawn()` consume both output streams and wait for process completion concurrently so final output cannot race process exit.

The first runtime version supports Agent-local cwd narrowing. It cannot manufacture a narrower root or read-only downgrade after the outer lease is acquired. An Agent adapter must reject an effective nested view unless the runtime actually enforces the effective `root` and `access`.

The acquisition signal belongs to the complete evaluation domain. A cooperative provider stops pending setup and rejects with `signal.reason` when it is aborted. If a provider ignores cancellation and eventually returns a valid lease, AML captures the lease and releases it before rejecting the evaluation with the caller's cancellation reason.

When an outer Sandbox is inside a Workspace, `workspace` carries the active immutable materialization reference. Its directory is the provider-neutral shared snapshot; its handle is opaque data for compatible provider-specific transfer or mount optimizations. A Sandbox provider must either attach that materialization or reject acquisition. It must not silently use an unrelated configured directory.

### 13.4 Docker provider requirements

A Node-specific Docker provider uses an existing named image:

```tsx
import { dockerSandbox } from "@aml-jsx/sdk"

const docker = dockerSandbox({
  image: "company/aml-agents:2026-07",
  setup: "agent --version",
  workspace: approvedHostDirectory,
})

await runtime.evaluate(
  <Sandbox provider={docker} root="repository" access="read-only">
    <Agent>Inspect the repository.</Agent>
  </Sandbox>
)
```

The factory requires one normalized `image` name. Its optional `workspace` is the host-directory fallback for a standalone Sandbox. An active `<Workspace>` materialization supersedes that fallback; acquisition rejects if neither exists. `setup` is an optional trusted shell program and `maxOutputBytes` bounds command output. AML does not accept Dockerfiles, build contexts, Docker SDK clients, Agent packages, or installation policy.

The selected image owns its operating system, language runtimes, Agent SDKs and CLIs, development tools, user identity, and versions. It must contain POSIX `sh` and `sleep` for this first adapter. AML may document or publish useful images separately, but `dockerSandbox()` never builds one.

The provider uses the local Docker CLI to:

1. resolve the selected Workspace and requested root through the host filesystem
2. mount only that root at `/workspace`, read-only when requested
3. start the named image as one disposable container
4. run optional `setup` after the Workspace is visible and before descendants execute
5. translate runtime `exec()` calls into literal `docker exec` arguments and the effective guest cwd
6. force-remove the container on release

`setup` runs through `sh -lc` because it is explicit trusted application configuration. It runs on every acquisition, is not cached, and a non-zero exit rejects acquisition after cleanup. Repeated deployments should prefer an image or provider snapshot containing their dependencies.

The provider does not disable networking or impose generic CPU, memory, PID, root-filesystem, Linux capability, or user policy. Those choices belong to the selected image or a future explicitly configured Docker surface. Therefore this lightweight same-host Docker provider is a development and composition boundary, not a hostile multi-tenant security guarantee. It shares the host kernel and trusts the local Docker daemon.

One bind mount cannot enforce a narrower nested root or downgrade an existing read-write mount merely by changing cwd. Portable compatibility therefore rejects sessions whose effective root or access differs from the acquired runtime. Real-daemon tests must prove Workspace mount behavior, command execution, persistence, setup, and cleanup.

### 13.5 Local provider requirements

`localSandbox()` implements the same runtime with ordinary host child processes:

```tsx
const local = localSandbox({
  setup: "agent --version",
  workspace: approvedHostDirectory,
})
```

An active Workspace supersedes the optional standalone `workspace`. The provider resolves the selected root and each starting cwd through real paths, then executes literal commands with bounded output. Its optional trusted `setup` follows the same every-acquisition and fail-before-descendants semantics as Docker.

Local execution is explicitly non-isolating. A child process can access anything allowed to the AML host identity, including paths outside the logical Workspace. The provider rejects runtime execution under `"read-only"` because it cannot enforce that policy for arbitrary host processes. Unsandboxed `<Script>` uses the same trusted host-process boundary. Applications use either form only for trusted local development and automation; Docker or an enforcing remote provider is required for untrusted model-controlled commands.

### 13.6 Daytona provider requirements

`daytonaSandbox()` keeps Daytona's provider configuration native:

```tsx
const daytona = daytonaSandbox({
  config: {
    apiKey: process.env.DAYTONA_API_KEY,
    target: "us",
  },
  createOptions: {
    timeout: 90,
  },
  setup: "agent --version",
  snapshot: "aml-agents",
})
```

`config` is Daytona's `DaytonaConfig`. The mutually exclusive root `image` and `snapshot` options select the environment consistently with other Sandbox factories. `create` retains Daytona's remaining image- or snapshot-specific creation parameters, and `createOptions` preserves its creation timeout and image-build log callback. Applications may inject an already configured Daytona client instead of `config`, but not both. AML reconstructs Daytona's native request at the adapter boundary rather than translating these values into generic Sandbox configuration.

For each acquisition the provider:

1. resolves the active Workspace and selected root locally
2. creates a disposable Daytona Sandbox
3. uploads a complete archive and extracts it into `workspace` under Daytona's writable default working directory
4. runs optional trusted `setup`
5. maps literal runtime commands to Daytona process execution with the effective relative guest cwd
6. on read-write release, downloads a complete archive and mirrors additions, modifications, and deletions into the local materialization
7. deletes the Daytona Sandbox even when setup, execution, or reconciliation fails

The selected Daytona image or snapshot must contain the shell utilities and `tar` used for transfer plus any Agent dependencies. AML never builds the image or installs the Agent implicitly. The AML host must also provide `tar` for this first full-tree synchronization implementation.

Daytona's command API accepts a shell command string rather than literal argv, so the adapter quotes each command and argument before execution. Daytona returns one combined command output string; the provider maps it to `stdout` and returns an empty `stderr`. Cancellation destroys the disposable Sandbox because Daytona does not expose per-command cancellation through this API.

Daytona sessions stream logs and accept text input, but the SDK does not expose a literal stdin half-close. Closing the process handle's `stdin` therefore closes AML's writable stream without inventing an EOT convention. ACP cleanup does not rely on input closure to terminate work; `kill()` deletes the invocation-owned session and normalizes Daytona's resulting missing-session race into the cached killed exit result.

The transfer implementation cannot enforce a read-only guest tree. Like Local, Daytona therefore rejects runtime execution under `"read-only"` instead of claiming confinement it does not provide. Read-write reconciliation occurs before the outer Workspace saves its materialization. A failed reconciliation is reported and remote cleanup is still attempted.

### 13.7 `<Script>`

`<Script>` executes through the runtime of an active Sandbox when one exists. Without an active Sandbox it executes as
a trusted host process. Its working directory defaults to `AmlRuntimeOptions.cwd`, which defaults to `process.cwd()`:

```tsx
<Script cwd="apps/cli" command="npm" args={["test"]} />

<Sandbox provider={docker} access="read-write">
  <Script command="git" args={["clone", repository, "."]} />
  <Script cwd="packages/api" shell="sh">npm test</Script>
</Sandbox>
```

Exactly one execution form is required:

- `command` accepts an optional string `args` array, rejects children, and executes without shell interpolation
- `shell` is `"sh"`, `"bash"`, or `"node"` and executes its fully resolved child text

Both forms accept an optional portable relative `cwd`. On the host it resolves from `AmlRuntimeOptions.cwd`; inside a
Sandbox it resolves from the active Sandbox root. Without the prop, Script uses the host runtime cwd or the effective
Sandbox cwd respectively. Absolute paths, backslashes, and parent traversal are rejected. `cwd` selects the process
starting directory; it does not create that directory or confine a trusted host process.

`timeoutMs`, when present, is a positive safe integer passed to the selected process runtime. Interpreted source must
resolve to non-empty text. Child Agents may generate that source because Script executes after post-order child
resolution. Choosing Script accepts execution of the complete resolved text; AML does not distinguish trusted
literals from model-produced fragments. Applications must place generated or otherwise untrusted source inside a
Sandbox whose provider enforces the required filesystem, process, network, and credential policy.

Standard output becomes the Script result and can feed later AML. A non-zero exit rejects with its code and trimmed
standard-error detail. AML bounds, cancels, and reaps an unsandboxed host process directly. An active Sandbox instead
owns logical path mapping, confinement, executable availability, output bounds, cancellation, and cleanup; AML never
falls back from that selected Sandbox to the host.

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

Workspace owns durable identity, evaluation locking, materialization, atomic publication, and transfer. Sandbox owns
ephemeral execution and confinement.

### 14.1 Lifecycle

`id` defaults to `crypto.randomUUID()` when omitted. `cwd` defaults to `"."` and is a normalized relative path
beneath the materialization root. `load` defaults to `true`, which restores the indexed current revision. `lock`
defaults to `true`, `writeConcurrency` defaults to `"serial"`, and `save` defaults to `false`.

One Workspace evaluation:

1. acquires one Workspace materialization and, unless `lock={false}`, its writer lock
2. materializes the requested durable revision, or an empty tree when `load={false}`
3. evaluates its subtree
4. attaches and reconciles descendant Sandboxes
5. applies the save policy when enabled
6. releases the lease and temporary materialization
7. returns the child result or rethrows its error

`save: true` saves after success, discovers the whole tree subject to `.gitignore`, and retains one current revision.
`save.on: "always"` opts into saving partial work after descendant failure. Cancellation skips saving. If saving also
fails, AML surfaces the persistence failure without losing the original evaluation failure in traces or error
causality.

This is not a crash-safe execution checkpoint. Process or provider failure may lose unsynchronized changes unless the Workspace provider offers continuous or incremental persistence.

### 14.2 Multiple Sandboxes

Sequential Sandboxes operate on one logical working snapshot:

1. a Sandbox receives current Workspace contents
2. its subtree runs
3. changes synchronize into the Workspace snapshot
4. the next Sandbox sees those changes

Shared mounts may avoid copying. Remote providers may upload and download the selected directory. Observable file behavior must remain consistent.

Parallel read-only Sandboxes may use one Workspace revision. In the default `writeConcurrency="serial"` mode, AML
waits before acquiring another writable root Sandbox for the same materialization and holds that permit through
Sandbox release and reconciliation. Agents inside one Sandbox still share its live filesystem and may run in
parallel. `writeConcurrency="parallel"` permits multiple writable root Sandboxes; this is appropriate for shared
mounts, while providers that transfer independent snapshots may overwrite reconciled state.

Workspace providers may use disk, volume mounts, object storage, or another durable backend. When `lock` is enabled,
another acquisition of the same durable identity must reject with the provider-neutral `WorkspaceConflictError`
without returning a lease. Releasing the active lease must make that identity acquirable again. With `lock={false}`,
revision-backed providers may allow concurrent materializations but must still reject stale conditional publication;
direct mutable providers expose ordinary concurrent filesystem behavior. The error carries the stable code
`AML_WORKSPACE_CONFLICT` and the conflicting `workspaceId` so duplicated SDK packages can recognize the contract
without relying on `instanceof`.

A provider backed by a renewable distributed or filesystem lease may lose writer authority after a documented stale threshold. Such a provider must detect and report compromise through `save()` or `release()`, document whether overlap can leave partial edits, and must not claim fencing or unconditional exclusion across suspension. Providers with stronger locking may retain the unconditional contract.

A Sandbox without a Workspace is ephemeral. A Workspace without a Sandbox is durable but makes no confinement claim.

### 14.3 Provider contract

The Workspace provider owns durable storage and exposes one acquired materialization to AML:

```ts
interface WorkspaceProvider<Handle = unknown> {
  readonly name: string
  acquire(request: WorkspaceAcquireRequest): Promise<WorkspaceLease<Handle>>
}

interface WorkspaceAcquireRequest {
  evaluationId: string
  id: string
  load?: false | WorkspaceLoadRequest
  lock?: boolean
  save?: boolean
  signal: AbortSignal
}

interface WorkspaceLoadRequest {
  exclude: readonly string[]
  include?: readonly string[]
  revision: "current" | string
}

interface WorkspaceSaveRequest {
  exclude: readonly string[]
  gitignore: boolean
  include?: readonly string[]
  outcome: "failure" | "success"
  retention: number
  signal: AbortSignal
}

interface WorkspaceLease<Handle = unknown> {
  directory: string
  handle: Handle
  id: string
  release(): Promise<void>
  save(request?: WorkspaceSaveRequest): Promise<void>
}

interface WorkspaceMaterializationReference<Handle = unknown> {
  cwd: string
  directory: string
  handle: Handle
  leaseId: string
  provider: {
    name: string
  }
  workspaceId: string
  writeConcurrency: "serial" | "parallel"
}
```

`directory` is the runtime-visible materialization of the durable Workspace. A provider may implement it as a local
directory, mounted volume, synchronized remote snapshot, or another filesystem adapter, but descendant Sandboxes must
observe the same logical files and ordering guarantees from section 14.2. `save()` persists the requested selection
and `release()` relinquishes locks and temporary resources. AML calls enabled saves and release through failure-safe
cleanup and preserves multiple failures with causality. With locking enabled, `acquire()` must reject a competing
writer with `WorkspaceConflictError`; conformance propagates every other provider failure.

Include and exclude globs are relative to the materialization root. Explicit include patterns override `.gitignore`;
explicit excludes always win. Selected symbolic links and unsupported filesystem entries reject. `retention` is a
positive integer counting the newly published current revision and all retained history.

After acquisition AML captures an immutable `WorkspaceMaterializationReference` for descendant outer Sandboxes. `workspaceId` is the authored durable identity, `leaseId` is the provider's acquired resource identity, and `provider.name` is descriptive identity rather than acquisition authority. Descendants never receive `save()`, `release()`, or the Workspace provider's `acquire()` method.

`WorkspaceLease.handle` is opaque provider data. It may support optimized transfer or shared-mount integration with a compatible Sandbox provider, but AML does not expose it as a portable filesystem API. A Sandbox provider that cannot attach the reference must reject rather than run against different files.

### 14.4 Local Workspace provider

The Node-specific local provider binds one configured existing directory to one provider:

```tsx
const repository = localWorkspace({
  directory: "/work/repository",
})

await runtime.evaluate(
  <Workspace id="review-42" provider={repository}>
    <Sandbox provider={docker}>
      <Agent>Review and update the repository.</Agent>
    </Sandbox>
  </Workspace>
)
```

`localWorkspace({ directory })` is a lazy configured factory. Construction validates and resolves the configured
path relative to the current process but performs no filesystem I/O. Acquisition resolves symlinks, requires an
existing directory, checks cancellation, and normally obtains a zero-retry cross-process lock on that physical
directory. `lock={false}` deliberately skips it. The provider uses `proper-lockfile`; it does not implement its own
lock protocol.

The configured directory is the complete durable Workspace. The authored Workspace `id` remains its logical execution identity but does not select a child path. Two providers aimed at the same physical directory therefore contend even when their authored ids differ. Lock contention rejects with `WorkspaceConflictError` for the requesting id. Other filesystem and lock failures remain provider failures.

The local lock is a renewable filesystem lease rather than an OS-owned advisory lock. Its policy is fixed: refresh
every five minutes and allow recovery after twenty minutes without renewal. Timing is intentionally not part of the
provider API. The original provider records lost ownership as compromise and fails completion, but direct edits from
an overlap cannot be rolled back.

The local materialization is direct: descendants work against the configured directory and writes are durable as ordinary local filesystem mutations occur. `save()` performs no copy or snapshot; it verifies that the renewable lock was not reported compromised. `release()` relinquishes a healthy cross-process lock exactly once and reports an unreported compromise without leaking dependency lifecycle errors. Cancellation before acquisition prevents locking. Cancellation after a late successful lock releases it before propagating the caller's exact reason.

The lock lives beside the resolved physical directory rather than inside its contents, so that physical directory's parent must permit lock creation. The provider makes no sandboxing or filesystem-isolation claim. A descendant Sandbox provider must still enforce its own confinement and must reject the materialization if it cannot attach a same-host local directory.

### 14.5 Shared Workspace persistence

Revision-backed providers use `createPersistentWorkspaceProvider()` with a public `WorkspaceStorageAdapter`.
WorkspacePersistence owns temporary materialization, Globby selection, revision metadata, retention, archive
creation and validated extraction, folder manifests, and cleanup. The adapter owns scoped access and these
provider-native operations:

```ts
interface WorkspaceStorageAdapter<Handle = unknown> {
  readonly name: string
  acquire(request: WorkspaceStorageAcquireRequest): Promise<WorkspaceStorageLease<Handle>>
}

interface WorkspaceStorageLease<Handle = unknown> {
  readonly handle: Handle
  read(path: string): Promise<WorkspaceStorageObject | undefined>
  write(
    path: string,
    body: WorkspaceStorageBody,
    options?: WorkspaceStorageWriteOptions
  ): Promise<WorkspaceStorageVersion>
  list(prefix: string): Promise<readonly WorkspaceStorageEntry[]>
  delete(paths: readonly string[]): Promise<void>
  release(): Promise<void>
}
```

Storage paths are normalized relative paths within one acquired Workspace identity. Bodies are streaming.
Conditional writes support create-if-absent and replace-if-version. Versions are opaque adapter tokens.

The persistence format is `"archive" | "folder"` and defaults to `"archive"`. Archive means exactly one AML-created
`tar.gz` per revision. Folder means one manifest plus provider-native files beneath an isolated revision prefix.
Format is stored per revision, so changing provider configuration loads the old current revision in its original
format before saving the next revision in the new format.

Every revision-backed Workspace stores this provider-independent control object:

```ts
interface WorkspaceIndex {
  version: 1
  current: string
  revisions: readonly {
    createdAt: string
    format: "archive" | "folder"
    id: string
    path: string
  }[]
}
```

The object is stored as `workspace.json`; revisions live beneath `revisions/`. Saves upload a complete immutable
artifact before conditionally publishing the next index. Pruning occurs only after publication. Publication failure
keeps the previous current revision authoritative and attempts to remove the unreferenced upload. Pruning failure may
leave unreachable storage but must not delete current data.

The persistence layer validates index and manifest versions, paths, entry counts, extracted bytes, archive bytes,
archive entry types, and selected snapshot limits. Invalid or missing referenced state rejects; it never silently
starts fresh. A genuinely missing index represents a new Workspace.

### 14.6 Staged filesystem and S3 Workspace providers

`filesystemWorkspace({ directory, format?, temporaryDirectory? })` stores revision artifacts beneath the configured
durable directory and materializes each run in a unique temporary directory. With locking enabled it holds a fixed
renewable lock for the evaluation. Unlocked runs still use a short filesystem lock around the conditional
`workspace.json` replacement. It is the staged alternative to the direct `localWorkspace()` provider.

`s3Workspace({ bucket, client?, config?, prefix?, format?, temporaryDirectory? })` uses the same
WorkspacePersistence implementation. Its adapter maps opaque versions to ETags, conditional writes to S3
preconditions, and normally holds a fixed renewable `lock.json` lease until release. The lock refreshes every five
minutes and is recoverable after twenty minutes without renewal; these timings are not configurable. `lock={false}`
skips the lease but retains conditional index publication. The provider requires the configured service to honor the
conditional S3 operations used by locking and publication; the generic “S3-compatible” label alone is not a guarantee.

### 14.7 `<File>`

`<File>` writes its resolved child text beneath the active Workspace materialization:

```tsx
<Workspace provider={workspaceStore}>
  <File path="handoff/plan.md">
    <Agent>Write the implementation plan.</Agent>
  </File>
  <Agent>Read handoff/plan.md and execute it.</Agent>
</Workspace>
```

`path` is required, relative to the Workspace root, and uses portable forward-slash syntax. Absolute paths, parent
traversal, the root itself, symbolic-link destinations, and symbolic-link or non-directory parents reject. Missing
parent directories are created. The completed write atomically replaces a regular destination where the host
filesystem supports rename semantics.

File requires children, permits empty resolved content, and contributes no text to its surrounding prompt. A nested
Agent may therefore generate the file without duplicating its output into the parent Agent. File is valid only inside
a Workspace and, in the initial contract, outside any active Sandbox. Remote Sandbox guests may hold a newer copy
than the host materialization, so guest-side File writes remain unsupported until Sandbox exposes a portable file
operation.

## 15. Provider contract

### 15.1 Agent-session contract

The provider boundary is:

```ts
interface AmlTraceIdentity {
  parentSpanId?: string
  runId: string
  spanId: string
}

interface AgentProvider {
  readonly name: string
  run(request: AgentRequest, context: AgentExecutionContext): Promise<AgentResponse>
  supportsSandbox?(sandbox: SandboxSession): boolean
}

interface AgentRequest {
  followUps?: readonly string[]
  mcpServers: readonly AgentMcpServer[]
  model?: string
  permissions: AgentPermissions
  output?: {
    jsonSchema: Readonly<Record<string, AmlJsonValue>>
    type: "json"
  }
  prompt: string
  system: string
  tools: readonly AgentTool[]
  trace?: AmlTraceIdentity
}

interface AgentResponse {
  structured?: unknown
  text: string
}

interface AgentExecutionContext {
  events: AmlEventSubscriber
  signal: AbortSignal
  sandbox?: SandboxSession
  trace: AmlTraceIdentity
}
```

`runId` identifies one `AmlRuntime.evaluate()` call. `spanId` identifies the Agent session within that evaluation, and `parentSpanId` is present when the runtime can attribute the session to an enclosing execution boundary. Trace identities are opaque correlation values; providers must preserve them rather than deriving behavior from their format.

The runtime owns one event bus. Every provider receives a subscriber-only view scoped to the current evaluation through `AgentExecutionContext.events`. Providers may register evaluation-local listeners but cannot emit runtime events. A provider that allocates evaluation-owned resources registers a `once("finish", listener)` callback when it creates them. The runtime awaits finish listeners after every Agent and resource scope has settled and before `evaluate()` completes. A finish-listener failure rejects an otherwise successful evaluation, and failure during both execution and finish handling is preserved as an `AggregateError`. AML authors never call provider cleanup from components or example functions.

JavaScript Tools contain a name, description, model-facing input schema, and async execution function. MCP servers contain either a provider-native name or one explicit standard transport descriptor.

An omitted or empty `followUps` array represents a single-input Agent. When FollowUps are present, the adapter:

1. creates one fresh provider session
2. registers Agent-wide Tool and MCP capabilities for its complete lifetime
3. sends `prompt`
4. sends each `followUps` entry after the preceding response
5. applies structured output only to the final input
6. returns only the final response
7. disposes invocation-scoped Tool registrations and MCP connections after the session settles; if the provider cannot remove dynamic registrations, its adapter must use a disposable provider host or reject that capability rather than accumulate registrations in shared provider state

For built-in coding-agent providers, this lifecycle is implemented once by the shared ACP session engine. A profile supplies:

- the command, arguments, and explicit environment needed to launch its ACP Agent
- capability negotiation requirements
- model and system-instruction mappings not standardized by ACP
- native permission mappings and their enforcement limits
- provider-specific configuration that remains behind the profile boundary

The engine owns process launch, stream pumping, ACP initialization, `session/new`, sequential `session/prompt` calls, updates, cancellation, final response collection, and cleanup. Profiles must not fork that lifecycle or bypass it with a vendor SDK, one-shot CLI command, embedded Agent loop, or provider-specific server.

Without an active Sandbox, the engine uses AML's trusted local process launcher. With an active Sandbox, it uses only that lease's `SandboxRuntime.spawn()`. The selected environment must already contain the profile's compatible ACP executable; providers do not install software implicitly.

Any failed turn rejects `run()`.

The exact internal adapter class structure is not normative. The observable session, ordering, capability, failure, and output semantics are.

### 15.2 Execution context

The runtime always passes an `AgentExecutionContext`.

When a Sandbox is active, the runtime calls `supportsSandbox(session)` on the provider selected for that Agent. The method must return exactly `true` before the Agent runs. A missing method, `false`, or another value rejects evaluation and the Sandbox lease is still released. This explicit handshake prevents a provider from silently ignoring an execution boundary.

A built-in Agent profile must not claim compatibility with a Sandbox provider until its ACP process runs through that lease's `SandboxRuntime.spawn()` at the effective Workspace cwd. Native Agent operations remain subject to the actual Sandbox enforcement boundary. A custom structural provider must document and prove an equivalent attachment; it cannot claim compatibility merely because one of its Tools delegates shell commands into the lease.

### 15.3 Provider construction and options

Public provider integrations must use configured factory functions:

```tsx
const sandbox = dockerSandbox({
  image: "company/aml-agents:2026-07",
  workspace: repositoryRoot,
})

const workspace = s3Workspace({
  bucket: "agent-workspaces",
  region: "eu-west-1",
})
```

This combines an injected Strategy with an Adapter-specific factory:

- the factory receives and validates backend-specific configuration
- the returned provider is an immutable configured strategy
- the factory is synchronous and performs no resource or network work
- `acquire()` owns asynchronous infrastructure creation
- JSX receives the configured provider through dependency injection

Portable AML props remain on the primitive. For Sandbox those are `root`, `cwd`, and `access`; for Workspace they are durable identity and the authored subtree. Backend addresses, credentials, images, snapshots, buckets, provider-native resources, and clients belong to provider factories.

AML does not forward arbitrary JSX props to providers, accept an untyped `providerOptions` bag, or resolve string names such as `provider="docker"`. Those shapes weaken type inference, hide dependencies behind a registry, and couple the language to every adapter's option surface.

Applications may construct multiple differently configured providers from the same factory and choose between those instances with ordinary TypeScript.

An Agent selects a configured provider through its `provider` prop or the runtime default:

```tsx
const fast = claudeAgent({ model: "anthropic/claude-haiku-4-5" });
const deep = codexAgent({ workingDirectory: process.cwd() });

<Agent provider={fast}>Classify the request.</Agent>
<Agent provider={deep} model="gpt-5.3-codex">
  Audit the result.
</Agent>
```

The model prop is the one intentionally portable per-Agent provider override. Other provider-specific options stay type-safe on the configured factory until AML defines a real cross-provider contract for them.

### 15.4 Definition helpers

`@aml-jsx/sdk` exports capability and provider definition helpers:

```ts
defineMcpServer(definition)
defineAgentProvider(implementation)
defineSandboxProvider(implementation)
defineWorkspaceProvider(implementation)
```

These helpers are the supported authoring surface for official and third-party adapters. Each helper preserves the implementation's generic types, validates its stable identity and contract, and returns the corresponding public SDK type. Provider names must already be non-empty and equal to their trimmed form; provider helpers reject non-normalized names instead of rewriting a runtime value behind its inferred TypeScript type. Definition helpers perform no network access, client creation, resource acquisition, or vendor-option interpretation. Provider helpers perform no global registration. `defineTool()` and `defineMcpServer()` register only the weak exact identities documented below.

A configured provider's identity and invocation method are captured when it enters its runtime or Agent boundary. AML does not repeatedly read those members while resolving or executing the same Agent.

Official provider packages use the same public helpers available to application authors:

```ts
import { defineAgentProvider, type AgentProvider } from "@aml-jsx/sdk"

export interface OpenCodeAgentOptions {
  model?: string
  // OpenCode-specific configuration remains owned by this package.
}

export function opencodeAgent(options: OpenCodeAgentOptions): AgentProvider {
  return defineAgentProvider({
    name: "opencode",
    async run(request, context) {
      // Create or reuse OpenCode resources only when this call needs them.
      return runOpenCode(options, request, context)
    },
  })
}
```

The provider package's configured factory owns vendor-specific options and returns an immutable adapter. The `define*Provider()` helper owns only the shared contract boundary. In design-pattern terms this is Ports and Adapters combined with configured factories and typed definition helpers; there is no service locator or global provider registry.

`defineMcpServer()` validates and freezes an MCP server identity and explicit standard transport descriptor. It does not start a process, connect to a URL, initialize an MCP client, or register provider configuration. Like `defineTool()`, it records only the exact object identity in a realm-global `Symbol.for()` WeakMap so separate physical SDK copies can recognize each other's definitions without accepting clones. The registry contains no credentials beyond references to the already-live definitions, is not enumerable application configuration, and does not outlive those weakly held objects.

The SDK provider interfaces remain public and structurally implementable. Direct implementations are allowed, but they must satisfy the same contract and conformance suite. The provider definition helpers are the canonical path because they preserve inference and make runtime validation consistent; official packages must use them.

The SDK also exports optional `AbstractAgentProvider` and `AbstractSandboxProvider` authoring templates. They do not replace the structural interfaces and AML never uses `instanceof` to recognize a provider. `AbstractAgentProvider` owns the stable provider-neutral turn template for custom structural providers. Built-in coding agents use the shared ACP engine directly and do not subclass it to create vendor-specific session lifecycles. `AbstractSandboxProvider` owns staged provisioning, post-provision initialization, failure compensation, immutable lease creation, and one shared release barrier around an acknowledged `ProvisionedSandbox`, while subclasses retain environment creation, runtime translation, reconciliation, and destruction.

Every concrete Agent adapter must explicitly implement its Sandbox compatibility claim; the Agent base fails closed by default. Every Sandbox command adapter may use `SandboxCommand` to capture the common command, argument, cwd, environment, signal, and timeout contract before translating it to a backend. AML validates and freezes every `SandboxRuntime.exec()` result and `SandboxRuntime.spawn()` process handle before exposing it to an Agent.

These bases are implementation aids rather than additional observable provider authority. A structural implementation passed through `define*Provider()` remains equally valid, and conformance plus runtime validation—not inheritance—enforces the contract.

AML does not expose a generic `defineProvider()`. Agent, Sandbox, and Workspace providers have different lifecycles and capability contracts, so one generic helper would erase useful constraints. AML also does not expose `defineWorkspace()`: `<Workspace>` is the authored resource primitive, while `defineWorkspaceProvider()` authors its backend implementation.

`defineAgent()` is not currently normative. An ordinary async function component already defines a reusable Agent composition. The name may be introduced only if a future Agent definition owns distinct runtime semantics that a component and `defineAgentProvider()` do not express.

## 16. Runtime, limits, and observability

```tsx
const runtime = new AmlRuntime({
  agentProvider: provider,
  allowedMcpServers: ["github", "project"],
  allowedTools: ["lookup_customer"],
  cwd: import.meta.dirname,
  maxAgentCalls: 32,
  maxConcurrentAgents: 4,
  maxDepth: 16,
  maxStateTransitions: 16,
  maxTurnsPerAgent: 16,
  onTraceError(error, event) {
    console.error("Trace listener failed", event.type, error)
  },
  system: "Global application instructions.",
})

runtime.on("trace", createConsoleTracer())
runtime.once("finish", async ({ status }) => {
  await recordRunCompletion(status)
})
```

Defaults:

| Option                |         Default | Meaning                                               |
| --------------------- | --------------: | ----------------------------------------------------- |
| `agentProvider`       |            none | Default provider for Agents without a `provider` prop |
| `maxAgentCalls`       |            `32` | Maximum Agent sessions in one evaluation              |
| `maxConcurrentAgents` |             `4` | Maximum active Agent sessions                         |
| `maxDepth`            |            `16` | Maximum recursive AML evaluation depth                |
| `maxStateTransitions` |            `16` | Maximum committed Loop transitions                    |
| `maxTurnsPerAgent`    |            `16` | Maximum authored inputs in one Agent session          |
| `onTraceError`        |     stderr once | Out-of-band trace failure handler                     |
| `allowedMcpServers`   |    unrestricted | Optional MCP-server-name allowlist                    |
| `allowedTools`        |    unrestricted | Optional Tool-name allowlist                          |
| `cwd`                 | `process.cwd()` | Base directory for local Skill files and host Scripts |
| `system`              |           empty | First system fragment for every Agent                 |
| `trace`               |            none | Synchronous execution-event callback                  |

For every `max*` option, `0` means unlimited. Supplied values must be non-negative safe integers.

One multi-turn Agent counts as one Agent session, not one call per FollowUp. Every initial prompt and FollowUp counts toward `maxTurnsPerAgent`. Provider-internal model/tool loops do not increment either authored limit.

`runtime.evaluate()` returns a string. A text-only tree does not require an Agent provider. An Agent without a local or runtime-default provider rejects. Invalid placement, invalid values, provider errors, schema errors, missing resources, and exceeded limits reject.

### 16.1 Runtime events

The runtime is the only event publisher. `AmlRuntime` exposes `on()` and `once()` for runtime-wide subscribers, while execution contexts receive the same registration surface scoped to their evaluation:

```ts
interface AmlEventSubscriber {
  on<Name extends AmlEventName>(name: Name, listener: AmlEventListener<Name>): () => void
  once<Name extends AmlEventName>(name: Name, listener: AmlEventListener<Name>): () => void
}

type AmlEventName = "start" | "finish" | "trace"

interface AmlEvaluationStartEvent {
  readonly runId: string
  readonly signal: AbortSignal
}

interface AmlEvaluationFinishEvent {
  readonly error?: unknown
  readonly runId: string
  readonly signal: AbortSignal
  readonly status: "error" | "ok"
}

type AmlEventListener<Name extends AmlEventName> = Name extends "trace"
  ? TraceSink
  : (event: AmlEventMap[Name]) => Promise<void> | void
```

`on()` returns an unsubscribe function. `once()` removes its listener before the first matching call. Context listeners receive events only from their evaluation and are removed when it finishes; runtime listeners may observe every evaluation executed by that runtime.

The SDK uses Hookable as the typed registration and dispatch substrate instead of maintaining separate observer and lifecycle registries. Hookable remains internal: subscribers can register and unregister listeners but cannot publish events. Every evaluation owns an independent scoped Hookable registry rather than registering run-filtering wrappers on the runtime-wide registry.

`start` listeners are awaited sequentially before AML begins evaluating the authored tree and fail fast: after one rejects, later setup listeners do not run. `finish` listeners are awaited after the tree, Agent scheduler, Sandbox leases, and Workspace lease have settled. Every finish listener is given a chance to run; multiple failures are preserved. The `status` and optional `error` fields describe execution as it enters the finish phase; a finish-listener failure can still reject an evaluation whose finish event reported `status: "ok"`. The root evaluation trace closes only after finish listeners settle, so cleanup failure is visible in both the returned error and trace status.

`trace` is the common observability event. Every trace listener begins synchronously and is isolated from every other listener; one synchronous throw cannot suppress listeners registered after it. Trace listeners may return a Promise, but AML never awaits it. Every throw or rejection is reported independently through the isolated trace-error channel without delaying or failing the workflow. `createConsoleTracer()`, test inspectors, visual tree consumers, and future telemetry exporters subscribe through this event rather than a separate dispatcher API.

### 16.2 Trace contract

AML publishes one immutable, provider-neutral event stream:

```ts
type AmlTraceAttribute = boolean | number | string | readonly string[]

type AmlTraceSpanKind =
  "evaluation" | "component" | "agent" | "system" | "skill" | "tool" | "loop" | "sandbox" | "workspace"

type AmlTraceEvent =
  | {
      type: "span.start"
      kind: AmlTraceSpanKind
      name: string
      attributes: Readonly<Record<string, AmlTraceAttribute>>
      runId: string
      spanId: string
      parentSpanId?: string
      sequence: number
      timestamp: number
    }
  | {
      type: "span.end"
      kind: AmlTraceSpanKind
      name: string
      status: "ok" | "error"
      durationMs: number
      attributes: Readonly<Record<string, AmlTraceAttribute>>
      runId: string
      spanId: string
      parentSpanId?: string
      sequence: number
      timestamp: number
    }
  | {
      type: "event"
      name: "agent.turn" | "capability.mcp" | "capability.tool" | "loop.transition"
      attributes: Readonly<Record<string, AmlTraceAttribute>>
      runId: string
      spanId: string
      parentSpanId?: string
      sequence: number
      timestamp: number
    }

interface TraceSink {
  (event: AmlTraceEvent): unknown
  readonly captureContent?: boolean
}
```

The event stream covers evaluation and component execution, Agent sessions and authored turns, System and Skill resolution, JavaScript Tool calls, committed Loop transitions, and Sandbox and Workspace scope lifecycles. Tool and MCP descriptor events describe capability grants; they do not claim that a provider completed a remote attachment lifecycle AML cannot observe. `capability.tool` identifies the JavaScript Tool `name`. `capability.mcp` identifies the server `name` and whether its `kind` is `named`, `stdio`, or `streamable-http`; it never includes transport configuration.

Every event includes `runId`, `spanId`, a monotonically increasing evaluation-local `sequence`, and a Unix-millisecond `timestamp`. Nested events include `parentSpanId`. `span.end` reuses its `span.start` identity and reports non-negative elapsed milliseconds. An evaluation span is the root ancestor of every other span, including component-local `evaluate()` calls and concurrently scheduled Agents. Each lexical execution boundary is the direct parent of the subtree it evaluates: a component returning an Agent owns that Agent span, and Workspace, Sandbox, Loop, System, and Skill descendants remain beneath their corresponding spans.

Agent spans begin when the runtime enters the authored Agent, before Agent-specific prop and Sandbox preflight, and include post-order request assembly plus the provider session. The runtime closes a successful Agent span only after its result enters the parent AML output channel. FollowUps remain inside that Agent span. `agent.turn` events are emitted in authored order at the provider handoff: the initial prompt is turn `1`, and the first FollowUp is turn `2`. Provider-internal reasoning, retries, tool loops, token accounting, and usage records are not part of the stable Slice 15 contract because the portable provider interface cannot observe them consistently.

Trace sinks supplied through the compatibility `trace` runtime option are registered as `trace` event listeners. Each evaluation still owns its ordering counter, root span, and failure-warning state. A listener receives deeply immutable snapshots rather than request, response, Tool, provider, lease, or component objects. It runs outside component-local `evaluate()` access and cannot mutate workflow inputs or results through the event API.

Compatibility trace sinks and listeners registered through `runtime.on("trace", ...)` share the same contract. A thrown error or returned Promise cannot change workflow behavior or suppress another listener. `onTraceError(error, event)` receives every listener failure through an isolated secondary channel; otherwise AML emits at most one compact stderr warning per evaluation. Errors and asynchronous rejections from the secondary handler are swallowed.

Prompts, System and Skill contents, Tool input/output, MCP configuration, filesystem paths, and model output may be sensitive. These values are omitted by default. A sink with `captureContent: true` opts only that listener into the content fields the stable runtime owns. For an event with sensitive content, the runtime constructs separate deeply immutable redacted and content-bearing snapshots and selects between them per listener. One opted-in listener never exposes content to another listener. JavaScript Tool spans serialize the already captured transport input as `input` on `span.start` and the stable Tool result as `output` on a successful `span.end` only while the evaluation has at least one content listener. Serialization failure for unusually deep JSON omits optional content without replacing Tool validation or execution. Credential-bearing MCP configuration and provider-private diagnostics are never copied into AML events.

`createConsoleTracer()` renders the same event tree with indentation, span status, elapsed time, safe attributes, and optional captured content. A custom writer may be synchronous or asynchronous; throws and rejections are isolated and reported through the runtime trace-error channel. OpenTelemetry remains a possible consumer package after the event contract is proven; this phase does not export `createOpenTelemetryTraceSink()` or add an OpenTelemetry dependency.

### 16.3 Agent adapter requirements

Every built-in coding-agent adapter is a profile over the shared ACP session engine. Codex uses the maintained Codex ACP adapter, GitHub Copilot and OpenCode use their native ACP Agents, and Pi uses the maintained Pi ACP adapter. Public factories retain the ordinary product names:

```ts
function codexAgent(options?: CodexAgentOptions): AgentProvider
function copilotAgent(options?: CopilotAgentOptions): AgentProvider
function opencodeAgent(options?: OpenCodeAgentOptions): AgentProvider
function piAgent(options?: PiAgentOptions): AgentProvider
```

Factories are synchronous and perform no filesystem, process, credential, or network work. Invocation launches the selected ACP Agent in the active execution environment. The factory options configure the profile; they must not expose an alternative session client or lifecycle implementation.

Every profile resolves configuration in the same authority order:

1. provider defaults
2. explicit factory options and portable per-Agent overrides
3. imperative AML policy derived from the authored System, capabilities, Workspace, and Sandbox

The final AML layer must replace authority-bearing arrays, callbacks, clients, Tool grants, MCP grants, and capability policy rather than recursively combining them with user input. Vendor-native configuration remains native everywhere that AML has not defined a portable contract.

Every profile must:

- declare the compatible ACP executable and negotiated capabilities
- create one fresh ACP session per Agent and reuse it for FollowUps
- use the effective Workspace cwd for ACP `session/new`
- map the complete AML system channel and optional model without changing their meaning
- pass all explicit MCP servers and AML-owned Tool/output bridges at session creation, and resolve named native servers through explicit profile policy
- map portable Agent permissions where the harness exposes matching controls and report enforcement limits
- preserve `context.signal.reason`, request ACP cancellation when available, and always terminate invocation-owned resources
- keep credentials, configuration, protocol messages, session identifiers, and provider-native events behind the adapter boundary
- support both the trusted local process launcher and every advertised `SandboxRuntime.spawn()` implementation through the same engine

Codex, GitHub Copilot, OpenCode, and Pi may expose different profile options and native capabilities, but they must not own separate prompting, streaming, Tool bridging, structured-output, FollowUp, or cleanup algorithms. A provider-specific deviation requires a change to this specification and the shared engine, not a parallel lifecycle.

### 16.4 Built-in ACP profile mappings

All four built-in coding Agents use the lifecycle above. Their remaining differences are launch and configuration mappings:

- Codex launches `codex-acp`. It maps read-only versus read-write filesystem access to the adapter's Agent mode. The adapter does not expose exact shell or network switches, so an enclosing Sandbox remains responsible for those restrictions.
- GitHub Copilot launches `copilot --acp`. It uses an invocation-private `COPILOT_HOME`, disables automatic login discovery plus ambient instructions and MCP configuration, and maps narrowed filesystem, shell, and network requests to Copilot deny rules and tool exclusions. The enclosing Sandbox remains the hard execution boundary.
- OpenCode launches `opencode acp --pure`. It maps filesystem writes, shell, and its native web tools to the portable Agent permission request through an invocation-private OpenCode configuration. Because ACP has no system-message field and an OpenCode Agent `prompt` replaces OpenCode's model-specific base prompt, non-empty AML System content is prepended to the first turn inside literal `<SYSTEM>` tags; empty content adds no prelude.
- Pi launches `pi-acp`. Its normal built-in tools provide the optimistic defaults. When permissions are narrowed, AML supplies Pi's native `--tools` allowlist; `pi-mcp-adapter` is also required when the invocation uses JavaScript Tools, explicit MCP servers, or structured output.

Profiles may expose command, arguments, environment, model, credentials, and vendor-native configuration at their factories. They may not expose an injected alternate session lifecycle. The selected host or Sandbox must already contain compatible executables; AML does not install them during Agent execution.

JavaScript Tools and structured output use the same invocation-owned MCP bridge for every profile. For a remote Sandbox, a small Sandbox-local HTTP relay carries MCP requests over the invocation's `SandboxProcess` streams to the authenticated host bridge. The relay is transport-only: it cannot execute Tools or own structured-output state.

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
- Workspace volume mounts coordinated with compatible Sandbox providers
- network-mounted Workspaces, including SMB and NFS-style filesystems
- SFTP Workspace storage
- Google Drive Workspace storage
- first-class Git checkout, worktree, commit, push, or pull-request behavior
- Workspace-owned Skill materialization
- File host sources, append/create modes, binary content, and guest-side writes
- independent nested Sandbox acquisition
- installation or execution of remote Skill bundles

These are product and runtime decisions, not missing tags to add by default.

## 18. Complete example

```tsx
const Finding = z.object({
  file: z.string(),
  problem: z.string(),
})

const Session = createContext<ReviewSession>("ReviewSession")

function Reviewer() {
  const session = useContext(Session)
  const loadPatch = defineTool({
    name: "load_patch",
    description: "Load the patch for this review session.",
    input: z.object({}),
    execute: () => session.repository.loadPatch(),
  })

  return (
    <Agent>
      <Tool use={loadPatch} />
      <Skill src="./skills/evidence.md" />
      Review the patch and identify the highest-risk finding.
      <FollowUp>Challenge that finding against the surrounding implementation.</FollowUp>
      <FollowUp>Return the final finding as structured output.</FollowUp>
    </Agent>
  )
}

async function ReviewWorkflow() {
  const [finding, architecture] = await Promise.all([
    evaluate(<Reviewer />, Finding),
    evaluate(
      <Agent>Describe the architecture affected by this patch using the Agent's native repository tools.</Agent>
    ),
  ])

  return (
    <Agent>
      Synthesize the review. Finding: {JSON.stringify(finding)}
      Architecture: {architecture}
    </Agent>
  )
}

const runtime = new AmlRuntime({
  agentProvider: provider,
  allowedTools: ["load_patch"],
  trace: createConsoleTracer(),
})

const output = await runtime.evaluate(
  <Session.Provider value={reviewSession}>
    <Workspace provider={workspace} id={reviewSession.id}>
      <Sandbox provider={sandbox} access="read-only">
        <ReviewWorkflow />
      </Sandbox>
    </Workspace>
  </Session.Provider>
)
```

This example combines Sandbox confinement with durable Workspace lifecycle.
