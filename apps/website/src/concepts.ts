/** One homepage preview, with a short example and a route to the full documentation. */
export interface Concept {
  id: string
  group: "Concepts" | "Components" | "Runtime APIs"
  name: string
  description: string
  warning?: string
  docsPath: string
  file: string
  code: string
}

/** A curated introduction; the documentation owns the complete API reference. */
export const CONCEPTS: readonly Concept[] = [
  {
    id: "results-as-prompts",
    group: "Concepts",
    name: "Results become prompts",
    description:
      "Nest an Agent inside another Agent to pass its result into the parent's prompt. AML finishes the child before starting the parent. Use evaluate() inside a component when your application needs to inspect or transform a result before continuing.",
    docsPath: "docs/concepts/",
    file: "review-brief.tsx",
    code: `<Agent provider={Editor}>
  Write a release brief from this review:
  <Agent provider={Reviewer}>Review the latest changes.</Agent>
</Agent>`,
  },
  {
    id: "composition",
    group: "Concepts",
    name: "Composition",
    description:
      "An AML component is a TypeScript function that returns text, JSX, or an async result. Give it props and reuse it in other workflows. Components run when AML evaluates their node, so ordinary TypeScript can load data, branch, and compose the next step.",
    docsPath: "docs/ast/#type-application-components-explicitly",
    file: "review.tsx",
    code: `import type { AML } from "@aml-jsx/sdk"

const Review: AML.Component<{ path: string }> = ({ path }) => (
  <Agent provider={Reviewer}>Review {path}.</Agent>
)

const workflow = <Review path="src/billing.ts" />`,
  },
  {
    id: "injected-providers",
    group: "Concepts",
    name: "Provider choice",
    description:
      "Providers are configured values you pass to components. Choose a default at the runtime or select a provider for each Agent. Different coding agents can work alongside each other in the same tree, with their own models and native tools.",
    docsPath: "docs/providers/agents/",
    file: "providers.tsx",
    code: `<Parallel>
  <Agent provider={codexAgent({})}>Review correctness.</Agent>
  <Agent provider={opencodeAgent({})}>Review maintainability.</Agent>
</Parallel>`,
  },
  {
    id: "agent",
    group: "Components",
    name: "<Agent />",
    description:
      "Run a coding-agent session with a prompt, instructions, and tools. AML resolves the Agent's children before opening the session, then returns the provider's response as text. A provider can be set on this Agent or inherited from the runtime.",
    docsPath: "docs/reference/primitives/agent/",
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
    description:
      "Run independent branches together and combine their results in the order you wrote them. The parent waits for every branch before continuing. The runtime's concurrency limit still applies, and failed branches are reported together after cleanup.",
    docsPath: "docs/reference/primitives/parallel/",
    file: "parallel.tsx",
    code: `<Agent provider={Editor}>
  <Parallel>
    <Agent provider={Reviewer}>Review correctness.</Agent>
    <Agent provider={Auditor}>Review security.</Agent>
  </Parallel>
  Synthesize both reports.
</Agent>`,
  },
  {
    id: "include",
    group: "Components",
    name: "<Include />",
    description:
      "Read a file into an Agent's prompt. Use src for an application file, resolved from the runtime's working directory, or path for a file in the active Sandbox or Workspace. maxBytes bounds how much content AML includes directly.",
    docsPath: "docs/reference/primitives/include/",
    file: "include.tsx",
    code: `<Agent provider={OpenCode}>
  <Include src="./instructions/review.md" maxBytes={16_384} />
  Review src/index.ts.
</Agent>`,
  },
  {
    id: "skill",
    group: "Components",
    name: "<Skill />",
    description:
      "Give an Agent a local Agent Skills package, including its SKILL.md and supporting files. AML stages the package for that session and registers it through the provider. The agent can discover and read the skill as needed; its full instructions are not inserted into every prompt.",
    docsPath: "docs/reference/primitives/skill/",
    file: "skill.tsx",
    code: `<Agent provider={OpenCode}>
  <Skill src="./skills/evidence-review" />
  Review src/index.ts.
</Agent>`,
  },
  {
    id: "sandbox",
    group: "Components",
    name: "<Sandbox />",
    description:
      "Choose the execution environment for the agents inside it, such as Docker or a remote container. Set access and root to limit their filesystem permissions. Nested Sandboxes reuse the outer environment and can narrow its permissions further.",
    warning: "The local provider runs on your host. Use a container or remote provider when you need isolation.",
    docsPath: "docs/reference/primitives/sandbox/",
    file: "sandbox.tsx",
    code: `<Sandbox provider={Docker} access="read-write" root="repository">
  <Sandbox access="read-only" root="packages/api">
    <Agent provider={OpenCode}>Inspect without modifying files.</Agent>
  </Sandbox>
</Sandbox>`,
  },
  {
    id: "workspace",
    group: "Components",
    name: "<Workspace />",
    description:
      "Keep files between runs under a stable workspace ID. The provider loads the files before evaluating the children; save publishes the changes afterward. Select local files, filesystem revisions, or S3-compatible storage according to how the application should persist its work.",
    warning: "With localWorkspace(), save={false} does not undo local file changes.",
    docsPath: "docs/reference/primitives/workspace/",
    file: "workspace.tsx",
    code: `<Workspace id="release-review" provider={Project} save>
  <Sandbox provider={Docker} access="read-write">
    <Agent provider={OpenCode}>Review the release and write report.md.</Agent>
  </Sandbox>
</Workspace>`,
  },
  {
    id: "aml-runtime",
    group: "Runtime APIs",
    name: "AmlRuntime",
    description:
      "Evaluate a workflow from your application and receive its final text. Configure default providers, call limits, concurrency, and tracing at this boundary. The same runtime can evaluate multiple trees, with separate execution state for each run.",
    docsPath: "docs/reference/runtime/",
    file: "main.tsx",
    code: `const runtime = new AmlRuntime({
  agentProvider: opencodeAgent({}),
  maxAgentCalls: 6,
  maxConcurrentAgents: 2,
})
runtime.on("trace", createConsoleTracer())

const result = await runtime.evaluate(<Review />)`,
  },
  {
    id: "evaluate",
    group: "Runtime APIs",
    name: "evaluate()",
    description:
      "Evaluate a child tree from inside an active AML component. Pass a schema to receive validated, typed data instead of text, then use the result in ordinary TypeScript. This helper uses the current evaluation's providers, limits, and resource scopes.",
    docsPath: "docs/reference/runtime/#component-local-evaluation",
    file: "structured-review.tsx",
    code: `const Finding = z.object({ summary: z.string() })

const Review: AML.Component = async () => {
  const finding = await evaluate(<Agent>Find the main defect.</Agent>, Finding)
  return <Agent>Suggest a fix for: {finding.summary}</Agent>
}`,
  },
  {
    id: "define-tool",
    group: "Runtime APIs",
    name: "defineTool()",
    description:
      "Define a capability with an input schema and a handler. AML validates calls before running your code. Active components can call the resulting function directly; placing it in <Tool use={…} /> also makes it available to that Agent.",
    docsPath: "docs/reference/primitives/tool/",
    file: "order-tool.tsx",
    code: `const LookupOrder = defineTool({
  name: "lookup_order",
  description: "Find an order by ID",
  input: z.object({ id: z.string() }),
  execute: async ({ id }) => orders.findById(id),
})

const workflow = <Agent><Tool use={LookupOrder} />Find order 42.</Agent>`,
  },
  {
    id: "aml",
    group: "Runtime APIs",
    name: "AML",
    description:
      "Import AML as a type for workflow values and component definitions. AML.Component<Props> accepts synchronous or asynchronous results. Children are explicit: AML.PropsWithChildren<Props> adds optional, readonly children; use PropsWithRequiredChildren when callers must supply them.",
    docsPath: "docs/ast/#type-application-components-explicitly",
    file: "component-types.tsx",
    code: `import type { AML } from "@aml-jsx/sdk"

type SectionProps = AML.PropsWithChildren<{ title: string }>
const Section: AML.Component<SectionProps> = ({ title, children }) =>
  [title, ": ", children]

const workflow: AML = <Section title="Evidence">Inspect the changes.</Section>`,
  },
]
