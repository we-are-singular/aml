/**
 * Reference section content, condensed from README.md and SPEC.md.
 * Code samples stay close to the runnable examples in `examples/src`.
 */

export interface Concept {
  id: string
  group: "Concepts" | "Components" | "Runtime APIs"
  name: string
  signature: string
  description: string
  note?: string
  docsPath?: string
  file: string
  code: string
}

export const CONCEPTS: readonly Concept[] = [
  {
    id: "results-as-prompts",
    group: "Concepts",
    name: "Results become prompts",
    signature: "evaluate() → JSX interpolation",
    description:
      "An <Agent /> component's output is an ordinary value. Gather work concurrently, synthesize it, then place the result directly into another <Agent /> prompt.",
    note: "Data flows through JavaScript variables and JSX interpolation — AML does not hide it in a graph DSL.",
    file: "concepts/results-as-prompts.tsx",
    code: `const [linear, slack] = await Promise.all([
  evaluate(<Agent>Gather this week's Linear updates.</Agent>),
  evaluate(<Agent>Gather this week's Slack updates.</Agent>),
])

const synthesis = await evaluate(
  <Agent>Combine these updates: {linear} {slack}</Agent>,
)

return <Agent>Prepare the standup from: {synthesis}</Agent>`,
  },
  {
    id: "composition",
    group: "Concepts",
    name: "Composition",
    signature: "one result → another primitive",
    description:
      "Resolved AML can drive more than prompt text. Here one <Agent /> authors a <File />, <File /> materializes it in <Workspace />, and a later sandboxed <Agent /> reads and executes that handoff.",
    note: "The same post-order rule powers <Agent /> inside <Agent /> and <Agent /> inside <System />: the consumer runs only after its child result is complete.",
    file: "concepts/composition.tsx",
    code: `<Workspace id="review-42" provider={Project} save>
  <File path="handoff/plan.md">
    <Agent provider={Planner}>Write the implementation plan.</Agent>
  </File>

  <Sandbox access="read-write" provider={Docker}>
    <Agent provider={Builder}>
      Read handoff/plan.md, implement it, and write report.md.
    </Agent>
  </Sandbox>
</Workspace>`,
  },
  {
    id: "parallel-child-agents",
    group: "Concepts",
    name: "Parallel child Agents",
    signature: "<Parallel>…</Parallel>",
    description:
      "A parent <Agent /> can depend on several independent child branches. <Parallel> starts them together, preserves authored output order, and waits for every branch before the parent session opens.",
    note: "The runtime's Agent scheduler remains authoritative. One failed branch does not interrupt healthy siblings, and ParallelError reports every failed authored index after cleanup.",
    file: "concepts/parallel-child-agents.tsx",
    code: `function SecurityLane() {
  return <>Security: <Agent provider={Codex}>Review security.</Agent></>
}

function PerformanceLane() {
  return <>Performance: <Agent provider={Codex}>Review performance.</Agent></>
}

function Review() {
  return (
    <Agent provider={Codex}>
      <System>Synthesize the evidence. Invent nothing.</System>
      <Parallel>
        <SecurityLane />
        <PerformanceLane />
      </Parallel>
      Produce the final review.
    </Agent>
  )
}`,
  },
  {
    id: "execution-and-files",
    group: "Concepts",
    name: "Execution and durable files",
    signature: "<Workspace /> → <Sandbox />",
    description:
      "<Sandbox /> supplies the disposable place where an <Agent /> executes. <Workspace /> materializes files before that work begins and saves them after it ends.",
    note: "Use <Sandbox /> for confinement and execution; use <Workspace /> when files must survive beyond one disposable lease.",
    file: "concepts/execution-and-files.tsx",
    code: `<Workspace id="repository" provider={Local}>
  <Sandbox provider={Docker} root="workspace">
    <Agent provider={OpenCode}>
      Run the checks and update the report.
    </Agent>
  </Sandbox>
</Workspace>`,
  },
  {
    id: "injected-providers",
    group: "Concepts",
    name: "Provider agnostic",
    signature: "Codex | Copilot | OpenCode | Pi",
    description:
      "The same AML workflow can call different Agent providers side by side. Each adapter owns its model session while AML keeps concurrency, data flow, and lifecycle consistent.",
    note: "Providers are ordinary configured values, so selecting or mixing them is explicit in the authored workflow.",
    file: "concepts/provider-agnostic.tsx",
    code: `const Codex = codexAgent({})
const OpenCode = opencodeAgent({})

const [codexReview, openCodeReview] = await Promise.all([
  evaluate(
    <Agent provider={Codex}>Review correctness.</Agent>,
  ),
  evaluate(
    <Agent provider={OpenCode}>Review maintainability.</Agent>,
  ),
])`,
  },
  {
    id: "agent",
    group: "Components",
    name: "<Agent />",
    docsPath: "docs/reference/primitives/agent/",
    signature: '<Agent provider={…} system="…">',
    description:
      "Runs one provider-owned Agent session. AML first resolves its prompt children, <System /> content, capabilities, and child <Agent /> results — then hands one complete plan to the provider.",
    note: "The provider owns the model session and its native capabilities; AML owns everything around it.",
    file: "agent.tsx",
    code: `<Agent provider={OpenCode} system="Find concrete correctness defects.">
  <Tool use={ReadSource} />
  Review src/index.ts.
</Agent>`,
  },
  {
    id: "parallel",
    group: "Components",
    name: "<Parallel />",
    docsPath: "docs/reference/primitives/parallel/",
    signature: "<Parallel>…</Parallel>",
    description:
      "Evaluates independent AML branches concurrently, waits for all branch cleanup, and contributes successful text in authored order. Failures surface together as ParallelError.",
    note: "maxConcurrentAgents still bounds provider calls. <Parallel /> adds no retry, fail-fast cancellation, partial-result, or transactional side-effect policy.",
    file: "parallel.tsx",
    code: `<Agent provider={Coordinator}>
  <Parallel>
    <Agent provider={Reviewer}>Review correctness.</Agent>
    <Agent provider={Auditor}>Review security.</Agent>
  </Parallel>
  Synthesize both reports.
</Agent>`,
  },
  {
    id: "system",
    group: "Components",
    name: "<System />",
    docsPath: "docs/reference/primitives/system/",
    signature: "<System>…</System>",
    description:
      "Adds resolved content to the owning <Agent /> system prompt. Multiple <System /> blocks are joined in authored order — and a child <Agent /> can generate system content for its parent.",
    file: "system.tsx",
    code: `<Agent provider={OpenCode}>
  <System>You are a strict, evidence-first reviewer.</System>
  <System>{await loadHouseStyle()}</System>
  Review src/index.ts.
</Agent>`,
  },
  {
    id: "tool",
    group: "Components",
    name: "<Tool />",
    docsPath: "docs/reference/primitives/tool/",
    signature: "<Tool use={…} />",
    description:
      "Grants the owning <Agent /> one schema-validated JavaScript capability created with defineTool(). Grants are scoped — sibling <Agent /> components never see each other's tools.",
    file: "tool.tsx",
    code: `const ReadSource = defineTool({
  name: "read_source",
  description: "Read one source file from the current project",
  input: z.object({ path: z.string() }),
  execute: async ({ path }) => await readFile(path, "utf8"),
})

<Agent provider={OpenCode}>
  <Tool use={ReadSource} />
  Review src/index.ts.
</Agent>`,
  },
  {
    id: "skill",
    group: "Components",
    name: "<Skill />",
    docsPath: "docs/reference/primitives/skill/",
    signature: '<Skill src="./style.md" />',
    description:
      "Adds reusable instructions to the owning <Agent /> — inline content or a local file — without wiring another capability.",
    file: "skill.tsx",
    code: `<Agent provider={OpenCode}>
  <Skill>Prefer small, reversible diffs.</Skill>
  <Skill src="./skills/house-style.md" />
  Review src/index.ts.
</Agent>`,
  },
  {
    id: "file",
    group: "Components",
    name: "<File />",
    docsPath: "docs/reference/primitives/file/",
    signature: '<File path="handoff/plan.md">…</File>',
    description:
      "Writes resolved child text beneath the active <Workspace /> before later siblings run. A child <Agent /> can generate the contents, and <File /> does not duplicate that text into the surrounding prompt.",
    note: "<File /> currently writes the host Workspace before Sandbox acquisition; guest-side writes remain explicit <Agent /> or <Script /> work.",
    file: "file.tsx",
    code: `<Workspace id="review-42" provider={Project} save>
  <File path="handoff/plan.md">
    <Agent provider={Planner}>Create the migration plan.</Agent>
  </File>
  <Agent provider={Reviewer}>Review handoff/plan.md.</Agent>
</Workspace>`,
  },
  {
    id: "mcp",
    group: "Components",
    name: "<Mcp />",
    docsPath: "docs/reference/primitives/mcp/",
    signature: "<Mcp use={…} />",
    description:
      "Grants the owning <Agent /> an MCP server — provider-native by name, or an explicit server created with defineMcpServer(). Scope and lifecycle stay bound to that Agent session.",
    file: "mcp.tsx",
    code: `const Filesystem = defineMcpServer({
  name: "filesystem",
  transport: { type: "stdio", command: "mcp-server-fs", args: ["/repo"] },
})

<Agent provider={OpenCode}>
  <Mcp use={Filesystem} />
</Agent>`,
  },
  {
    id: "follow-up",
    group: "Components",
    name: "<FollowUp />",
    docsPath: "docs/reference/primitives/follow-up/",
    signature: "<FollowUp>…</FollowUp>",
    description:
      "Adds a later turn to the same provider-owned session. <FollowUp /> components are flat, ordered, and resolved before the session starts — the model keeps its own context between turns.",
    file: "follow-up.tsx",
    code: `<Agent provider={OpenCode}>
  Draft the migration plan.
  <FollowUp>Now estimate the risk of each step.</FollowUp>
  <FollowUp>Summarize in three bullets.</FollowUp>
</Agent>`,
  },
  {
    id: "sandbox",
    group: "Components",
    name: "<Sandbox />",
    docsPath: "docs/reference/primitives/sandbox/",
    signature: '<Sandbox access="read-only" root="…">',
    description:
      "Acquires an ephemeral execution environment and scopes a narrowed filesystem policy to descendant <Agent /> components. Nested <Sandbox /> components narrow further while sharing the outer lease.",
    file: "sandbox.tsx",
    code: `<Sandbox access="read-write" provider={Docker} root="repository">
  <Sandbox access="read-only" root="packages/api">
    <Agent provider={OpenCode} cwd="src">
      Inspect without modifying files.
    </Agent>
  </Sandbox>
</Sandbox>`,
  },
  {
    id: "script",
    group: "Components",
    name: "<Script />",
    docsPath: "docs/reference/primitives/script/",
    signature: '<Script cwd="…" command="…" /> | <Script shell="sh">',
    description:
      "Runs an argument vector or resolved sh, bash, or node source on the trusted host or through the active <Sandbox /> runtime. Relative cwd resolves from the host runtime cwd or active Sandbox root.",
    note: "<Script /> is deliberately dangerous. A cwd selects a starting directory, not a confinement boundary; an active Sandbox owns execution and never falls back to the host.",
    file: "script.tsx",
    code: `<Sandbox access="read-write" provider={Docker}>
  <Script cwd="packages/api" command="npm" args={["test"]} timeoutMs={120_000} />

  <Script shell="sh">
    <Agent provider={Planner}>Write a script that checks report.md.</Agent>
  </Script>
</Sandbox>`,
  },
  {
    id: "workspace",
    group: "Components",
    name: "<Workspace />",
    docsPath: "docs/reference/primitives/workspace/",
    signature: '<Workspace id="…" load save={…}>',
    description:
      "Loads one durable filesystem snapshot, supplies its cwd to descendant <Sandbox /> components, and optionally saves a selected, .gitignore-aware revision after execution.",
    note: "Run locking and write concurrency for <Sandbox /> components are separate controls: lock protects the durable identity across processes; writeConcurrency coordinates those components inside one evaluation.",
    file: "workspace.tsx",
    code: `<Workspace
  id="review-42"
  provider={S3}
  load
  save={{ include: ["src/**", "report.md"] }}
>
  <Sandbox access="read-write" provider={Docker}>
    <Agent provider={OpenCode}>Run the benchmark suite.</Agent>
  </Sandbox>
</Workspace>`,
  },
  {
    id: "fragment",
    group: "Components",
    name: "<> … </>",
    docsPath: "docs/reference/primitives/fragment/",
    signature: "<>…</>",
    description:
      "Groups AML values without adding prompt text or another runtime boundary — the plain JSX fragment, useful for composing capability bundles.",
    file: "fragment.tsx",
    code: `function ReviewCapabilities() {
  return (
    <>
      <System>You are a strict reviewer.</System>
      <Tool use={ReadSource} />
    </>
  )
}`,
  },
  {
    id: "aml-runtime",
    group: "Runtime APIs",
    name: "AmlRuntime",
    signature: "new AmlRuntime(options?)",
    description:
      "Evaluates a complete AML tree, owns budgets and lifecycle events, and returns the final text output. One runtime can evaluate many trees; each evaluation stays isolated.",
    file: "runtime.ts",
    code: `const runtime = new AmlRuntime({
  agentProvider: OpenCode,
  sandboxProvider: Docker,
  workspaceProvider: Project,
})
runtime.on("trace", createConsoleTracer())

const text = await runtime.evaluate(<Review />)`,
  },
  {
    id: "evaluate",
    group: "Runtime APIs",
    name: "evaluate()",
    signature: "evaluate(tree, schema?)",
    description:
      "Evaluates AML from inside an active component. Returns text by default — or schema-validated structured data when given a Standard Schema, the typed bridge between child and parent <Agent /> components.",
    file: "structured.tsx",
    code: `const Findings = z.object({ defects: z.array(z.string()) })

const findings = await evaluate(
  <Agent provider={OpenCode}>List concrete defects.</Agent>,
  Findings,
)

// findings.defects is fully typed and validated`,
  },
  {
    id: "define-tool",
    group: "Runtime APIs",
    name: "defineTool()",
    signature: "defineTool({ name, input, execute })",
    description:
      "Returns a typed callable with validated input and optional validated output. Active components can call it directly; <Tool use={tool} /> separately grants the same identity to one Agent.",
    file: "define-tool.ts",
    code: `const ReadSource = defineTool({
  name: "read_source",
  description: "Read one source file from the current project",
  input: z.object({ path: z.string() }),
  output: z.string(),
  execute: async ({ path }) => await readFile(path, "utf8"),
})

async function LoadSource() {
  return await ReadSource({ path: "src/index.ts" })
}`,
  },
  {
    id: "define-mcp-server",
    group: "Runtime APIs",
    name: "defineMcpServer()",
    signature: "defineMcpServer({ name, transport })",
    description:
      "Creates an immutable provider-neutral MCP descriptor for a local stdio process or a remote Streamable HTTP server.",
    file: "define-mcp-server.ts",
    code: `const Docs = defineMcpServer({
  name: "docs",
  transport: {
    type: "streamable-http",
    url: "https://mcp.example.com/docs",
  },
})`,
  },
  {
    id: "define-agent-provider",
    group: "Runtime APIs",
    name: "defineAgentProvider()",
    signature: "defineAgentProvider({ name, run })",
    description:
      "Finalizes an Agent harness adapter as an immutable AML provider. The implementation owns model sessions for a complete turn plan; AML owns resolution, capabilities scoping, and lifecycle.",
    note: "Adapters that also implement supportsSandbox() can execute inside <Sandbox />.",
    file: "define-agent-provider.ts",
    code: `export const myAgent = defineAgentProvider({
  name: "my-harness",
  async run(request, context) {
    const text = await runMyHarness(request.prompt, {
      tools: request.tools,
      signal: context.signal,
    })
    return { text }
  },
})`,
  },
  {
    id: "define-resource-providers",
    group: "Runtime APIs",
    name: "defineSandboxProvider() / defineWorkspaceProvider()",
    signature: "defineWorkspaceProvider({ name, acquire })",
    description:
      "Defines an ephemeral execution provider or a durable materialization provider. AML validates each acquired lease and owns save-before-release lifecycle ordering.",
    file: "define-providers.ts",
    code: `const FlyMachines = defineSandboxProvider({
  name: "fly-machines",
  // acquire / release confined machine leases
})

const S3Workspace = defineWorkspaceProvider({
  name: "s3",
  async acquire(request) {
    return materializeWorkspace(request)
  },
})`,
  },
  {
    id: "persistent-workspace-provider",
    group: "Runtime APIs",
    name: "PersistentWorkspace",
    signature: "createPersistentWorkspaceProvider({ storage, format? })",
    description:
      "Builds revision-backed Workspace behavior over a small storage adapter. AML owns archive or folder snapshots, selection, retention, validation, and atomic workspace.json publication.",
    note: 'format defaults to "archive"; adapters provide scoped read, write, list, delete, and release operations.',
    file: "persistent-workspace.ts",
    code: `const Project = createPersistentWorkspaceProvider({
  format: "archive",
  storage: new MyWorkspaceStorage(),
  temporaryDirectory: "/var/tmp",
})`,
  },
  {
    id: "workspace-factories",
    group: "Runtime APIs",
    name: "localWorkspace() / filesystemWorkspace() / s3Workspace()",
    signature: "s3Workspace({ bucket, config?, format? })",
    description:
      "Creates a built-in Workspace provider: direct local files, staged filesystem revisions, or S3-compatible object storage using the same persistence contract.",
    note: "S3-compatible services must honor the conditional writes used for locking and atomic index publication.",
    file: "workspace-providers.ts",
    code: `const Project = s3Workspace({
  bucket: "agent-workspaces",
  config: {
    endpoint: process.env.R2_ENDPOINT,
    region: "auto",
  },
  format: "archive",
})`,
  },
  {
    id: "runtime-on",
    group: "Runtime APIs",
    name: "runtime.on() / runtime.once()",
    signature: 'runtime.on("start" | "finish" | "trace", handler)',
    description:
      "Subscribes to evaluation lifecycle and trace events. start and finish bracket each evaluation; trace streams span.start / span.end / event records structured enough to build tooling on.",
    file: "observability.ts",
    code: `runtime.on("trace", createConsoleTracer())

runtime.on("start", ({ runId }) => log("evaluating", runId))
runtime.once("finish", ({ status }) => log("settled", status))`,
  },
]
