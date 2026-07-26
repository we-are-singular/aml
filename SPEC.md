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
const runtime = new AmlRuntime(provider, options);
const result = await runtime.evaluate(<Application />);
console.log(result);
```

Applications own provider construction, credentials, runtime configuration, and cleanup. A CLI is outside the AML language contract. Any `aml run main.tsx` command must execute the same TypeScript entry point and must not introduce a second AML syntax or require an `.aml` filename.

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

Examples and applications consume built package exports. They must not depend on SDK or provider source paths.

AML does not use names such as `@aml/agents/opencode` for independently installed providers because npm interprets that form as the `opencode` subpath of one `@aml/agents` package. Convenience aggregator packages are non-normative and may exist later, but cannot replace independently installable adapters.

## 2. Evaluation model

AML has two conceptual phases:

1. **Resolution** turns authored JSX into text and typed runtime descriptors.
2. **Execution** consumes those descriptors at boundaries such as `<Agent>`, `<Loop>`, `<Sandbox>`, and `<Workspace>`.

Not every resolved child becomes prompt text:

- text becomes message content
- `<Tool>` becomes an Agent capability
- `<Mcp>` becomes an Agent-scoped MCP server grant
- `<FollowUp>` becomes a staged later message
- `<Context.Provider>` changes descendant evaluation context
- `<Sandbox>` and `<Workspace>` own resource scopes

This distinction is important. A descriptor may be consumed later without its JSX being evaluated later.

### 2.1 Post-order consumers and lexical scopes

The core dataflow invariant is:

> Every value consumed by an AML boundary is fully resolved before that consumer executes.

`<Agent>` is the primary post-order consumer: child Agents, Skills, text, Tools, MCP servers, and FollowUps all resolve into its complete session plan before the provider session begins.

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
| MVP 1 | `<Agent>`, `defineAgentProvider()` | Establish the provider-neutral execution boundary |
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

```tsx
async function CustomerContext() {
  const customer = await database.customers.find(42);
  return `Customer: ${customer.name}`;
}
```

All components are asynchronous computations even when their functions do not use the `async` keyword.

### 4.1 Ordinary async semantics

AML invokes a component exactly once and awaits its result.

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
  system="You are a support operations lead."
>
  <Tool name="support.search" />
  Investigate customer 42.
</Agent>
```

Props:

```ts
interface AgentProps {
  children?: AmlRenderable;
  model?: string;
  system?: string;
}
```

### 5.1 Agent plan

AML completely resolves Agent children before opening the provider session. The conceptual result is an Agent plan:

```ts
interface AgentPlan {
  initialPrompt: string;
  followUps: readonly string[];
  mcpServers: readonly AgentMcpServer[];
  model?: string;
  system: string;
  tools: readonly AgentTool[];
}
```

This interface illustrates the semantics; it is not necessarily the exported runtime type.

Resolution:

1. Resolve all descendants post-order.
2. Preserve resolved text in authored order.
3. Collect Agent-level Tool descriptors.
4. Collect Agent-level MCP server descriptors.
5. Collect flat FollowUp descriptors in authored order.
6. Trim the initial prompt and each FollowUp prompt.
7. Combine runtime system text and Agent system text with one blank line.
8. Reject invalid or duplicate capabilities.
9. Open one provider session and execute the plan.

Text children are concatenated without implicit separators. JSX indentation is ordinary authored text; developers should add deliberate whitespace where needed.

### 5.2 Child Agents

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

### 5.3 Agent result

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

`<Skill>` resolves reusable instruction text before its containing execution boundary begins:

```tsx
<Agent>
  <Skill src="./skills/review/SKILL.md" />
  Review the change.
</Agent>
```

### 7.1 Source resolution

For a string `src`, the resolver applies these rules in order:

1. If `src` identifies an existing file or directory relative to the resolver's working directory, load it locally.
2. If `src` begins with `/`, treat it as an absolute local path.
3. If `src` is a slash-delimited `namespace/name` identifier, resolve it through the skills.sh detail API.
4. If `src` begins with `http://` or `https://`, fetch it as plain text.
5. Otherwise throw `SkillResolutionError`.

```tsx
<Skill src="./skills/reviewer.md" />
<Skill src="/opt/company/skills/reviewer/SKILL.md" />
<Skill src="mintlify.com/mintlify" />
<Skill src="vercel-labs/skills/find-skills" />
<Skill src="https://example.com/reviewer.md" />
<Skill>Always verify claims against code.</Skill>
```

An existing relative path wins even if its text resembles a skills.sh identifier. A local directory resolves to its `SKILL.md`.

The skills.sh API requires a Vercel OIDC token. `SkillResolver` reads `VERCEL_OIDC_TOKEN` by default or accepts `skillsShToken`. AML loads only the returned `SKILL.md` snapshot.

GitHub `/blob/` file URLs normalize to raw content. GitHub `/tree/` directory URLs resolve to `SKILL.md` in that directory.

`URL` objects are accepted. A `file:` URL loads locally, an HTTP(S) URL is fetched, and every other protocol fails closed.

Inline children bypass source resolution:

```tsx
<Skill>Prefer evidence over speculation.</Skill>
```

### 7.2 Trust and caching

- Resolution is cached by authored locator for the life of `SkillResolver`.
- A Skill is limited to 250,000 characters.
- Remote supporting files and scripts are not installed or executed.
- Resolved data records content, source kind, final locator, and a skills.sh content hash when provided.
- Provenance includes `trust: "inline" | "local" | "remote"`.
- `skill.resolved` traces include that provenance.
- `allowedSkillHosts` optionally restricts remote resolution by exact hostname.
- Remote Skill text is untrusted prompt input.

```tsx
const skillResolver = new SkillResolver({
  allowedSkillHosts: ["github.com", "skills.sh"],
  cwd: applicationDirectory,
  skillsShToken: process.env.VERCEL_OIDC_TOKEN,
});

const runtime = new AmlRuntime(provider, { skillResolver });
```

## 8. Tools

Tools are capabilities, not render-time calls.

`<Tool>` is a capitalized exported component. AML does not define lowercase HTML-like intrinsic elements.

```ts
type ToolProps = { name: string; use?: never } | { name?: never; use: AmlTool };
```

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

The input schema must satisfy both Standard Schema and Standard JSON Schema: AML validates every call before `execute()` runs and gives the generated JSON Schema to the Agent provider. An optional Standard Schema output contract validates the function result.

Every successful result must be a string or stable JSON data even without an output schema. AML rejects:

- `undefined`
- BigInts and non-finite numbers
- functions and symbols
- class instances
- Maps and Sets
- cyclic values

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
const runtime = new AmlRuntime(provider, {
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
const runtime = new AmlRuntime(agentProvider, {
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
}

interface SandboxLease<Handle = unknown> {
  handle: Handle;
  id: string;
  release(): Promise<void>;
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

The factory requires an explicit host `workspace` and exactly one of `image` or `dockerfile`. `buildContext`, CPU, memory, PID, tmpfs, user, and injected Docker client settings are provider configuration, not AML props.

At acquisition the provider:

1. resolves the configured workspace and requested root through the host filesystem
2. rejects roots or working directories whose real paths escape through a symlink
3. mounts only the selected root at `/workspace`
4. makes that bind mount read-only when AML access is `"read-only"`
5. disables networking
6. drops all Linux capabilities and enables `no-new-privileges`
7. runs as a non-root UID
8. makes the container root filesystem read-only with a bounded `/tmp`
9. applies CPU, memory, and PID limits
10. removes the container when the Sandbox lease releases

The lease handle exposes argument-array `exec()` without a host shell. A compatible Agent adapter can use it while keeping model-controlled commands inside the container.

One container cannot enforce a narrower nested filesystem root or downgrade an existing read-write bind mount to read-only merely by changing `cwd`. `supportsDockerSandbox(session)` therefore rejects effective sessions whose root or access differs from the acquired lease. Another adapter may enforce narrowing through constrained tools, an inner process sandbox, or a distinct explicit fork operation; it must not claim enforcement based on working directory alone.

Docker is a useful local process/filesystem boundary, not a hostile multi-tenant security guarantee. It shares the host kernel and trusts the Docker daemon. The provider never mounts the Docker socket.

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

Parallel read-only Sandboxes may use one Workspace revision. The initial runtime must serialize or reject conflicting writable attachments; it must not silently apply last-writer-wins copies.

Workspace providers may use disk, Docker volumes, object storage, Durable Objects, or another durable backend. They must expose version conflict or exclusive writer semantics.

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
```

`directory` is the runtime-visible materialization of the durable Workspace. A provider may implement it as a local directory, mounted volume, synchronized remote snapshot, or another filesystem adapter, but descendant Sandboxes must observe the same logical files and ordering guarantees from section 14.2. `save()` persists the current materialization and `release()` relinquishes locks and temporary resources. AML calls both through failure-safe cleanup and preserves multiple failures with causality.

`WorkspaceLease.handle` is opaque provider data. It may support optimized transfer or shared-mount integration with a compatible Sandbox provider, but AML does not expose it as a portable filesystem API.

## 15. Provider contract

### 15.1 Agent-session contract

The provider boundary is:

```ts
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

Host Tools contain a name. JavaScript Tools contain a name, description, model-facing input schema, and async execution function. MCP servers contain either a provider-native name or one explicit standard transport descriptor.

An omitted or empty `followUps` array represents a single-input Agent. When FollowUps are present, the adapter:

1. creates one fresh provider session
2. registers Agent-wide Tool and MCP capabilities for its complete lifetime
3. sends `prompt`
4. sends each `followUps` entry after the preceding response
5. applies structured output only to the final input
6. returns only the final response
7. disposes invocation-scoped Tool registrations and MCP connections after the session settles

Any failed turn rejects `run()`.

The exact internal adapter class structure is not normative. The observable session, ordering, capability, failure, and output semantics are.

### 15.2 Execution context

The runtime always passes an `AgentExecutionContext`.

When a Sandbox is active, the runtime calls `provider.supportsSandbox(session)`. The method must return exactly `true` before the Agent runs. A missing method, `false`, or another value rejects evaluation and the Sandbox lease is still released. This explicit handshake prevents a provider from silently ignoring an execution boundary.

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

### 15.4 Definition helpers

`@aml/sdk` exports capability and provider definition helpers:

```ts
defineMcpServer(definition);
defineAgentProvider(implementation);
defineSandboxProvider(implementation);
defineWorkspaceProvider(implementation);
```

These helpers are the supported authoring surface for official and third-party adapters. Each helper preserves the implementation's generic types, validates and normalizes stable provider identity and required lifecycle methods, and returns the corresponding public SDK contract. It performs no network access, client creation, resource acquisition, global registration, or vendor-option interpretation.

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
const runtime = new AmlRuntime(provider, {
  allowedMcpServers: ["github", "project"],
  allowedTools: ["read", "lookup_customer"],
  maxAgentCalls: 32,
  maxConcurrentAgents: 4,
  maxDepth: 16,
  maxStateTransitions: 16,
  maxTurnsPerAgent: 16,
  onTraceError(error, event) {
    console.error("Trace sink failed", event.type, error);
  },
  skillResolver,
  system: "Global application instructions.",
  trace,
});
```

Defaults:

| Option | Default | Meaning |
| --- | --: | --- |
| `maxAgentCalls` | `32` | Maximum Agent sessions in one evaluation |
| `maxConcurrentAgents` | `4` | Maximum active Agent sessions |
| `maxDepth` | `16` | Maximum recursive AML evaluation depth |
| `maxStateTransitions` | `16` | Maximum committed Loop transitions |
| `maxTurnsPerAgent` | `16` | Maximum authored inputs in one Agent session |
| `onTraceError` | stderr once | Out-of-band trace failure handler |
| `allowedMcpServers` | unrestricted | Optional MCP-server-name allowlist |
| `allowedTools` | unrestricted | Optional Tool-name allowlist |
| `system` | empty | System text prepended to every Agent |
| `skillResolver` | default resolver | Skill resolution and caching |
| `trace` | none | Synchronous execution-event callback |

For every `max*` option, `0` means unlimited. Supplied values must be non-negative safe integers.

One multi-turn Agent counts as one Agent session, not one call per FollowUp. Every initial prompt and FollowUp counts toward `maxTurnsPerAgent`. Provider-internal model/tool loops do not increment either authored limit.

`runtime.evaluate()` returns a string. Invalid placement, invalid values, provider errors, schema errors, missing resources, and exceeded limits reject.

### 16.1 Trace contract

The trace sink receives typed events for:

- evaluation start, completion, and failure
- component start, completion, and failure
- Agent session start, completion, and failure
- Agent turns and their ordering
- Skill resolution and provenance
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

The OpenCode adapter:

- creates one fresh OpenCode session per Agent
- disables all tools before enabling declared Tools
- maps named Tools to host capabilities
- exposes JavaScript Tools through one invocation-scoped localhost MCP bridge
- attaches declared provider-native and explicit MCP servers for the complete OpenCode session
- supports native structured output where available
- uses a JSON-only prompt fallback for `opencode-go`
- filters private reasoning from AML traces
- records session events, visible response parts, tokens, and cost

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

const runtime = new AmlRuntime(provider, {
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
