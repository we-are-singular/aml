/**
 * Playground scenarios: condensed versions of the real examples in
 * `examples/src`, paired with scripted trace timelines that mirror what a
 * deterministic provider emits during evaluation.
 */

export type NodeState = "idle" | "resolving" | "running" | "done"
export type EdgeState = "idle" | "hot" | "done"
export type Tone = "info" | "ok" | "warn"

export interface TreeNode {
  id: string
  label: string
  x: number
  y: number
}

export interface TreeEdge {
  id: string
  from: string
  to: string
}

export type PlayEvent =
  | { at: number; kind: "code"; lines: number[] }
  | { at: number; kind: "node"; id: string; state: NodeState }
  | { at: number; kind: "edge"; id: string; state: EdgeState }
  | { at: number; kind: "trace"; text: string; tone: Tone }
  | { at: number; kind: "output"; text: string }

export interface Scenario {
  id: string
  tab: string
  title: string
  file: string
  code: string
  nodes: readonly TreeNode[]
  edges: readonly TreeEdge[]
  events: readonly PlayEvent[]
  /** ms after the last event before the run is considered finished */
  duration: number
}

const REVIEW_CODE = `import { Agent, AmlRuntime, evaluate } from "@aml/sdk"

async function Review() {
  const [correctness, maintainability] = await Promise.all([
    evaluate(
      <Agent provider={OpenCode} system="Find concrete correctness defects.">
        <Tool use={ReadSource} />
        Review src/index.ts.
      </Agent>,
    ),
    evaluate(
      <Agent provider={OpenCode} system="Find proportionate improvements.">
        <Tool use={ReadSource} />
        Review src/index.ts.
      </Agent>,
    ),
  ])

  return (
    <Agent provider={OpenCode} system="Synthesize evidence, invent nothing.">
      Correctness: {correctness}
      Maintainability: {maintainability}
    </Agent>
  )
}

console.log(await runtime.evaluate(<Review />))`

const REVIEW_OUTPUT = `Correctness: unchecked readFile may throw ENOENT; unguarded index access at L88.
Maintainability: extract provider dispatch into a named helper.
— synthesized from 2 specialist reviews · 0 findings invented
`

const review: Scenario = {
  id: "review",
  tab: "parallel specialists",
  title: "Promise.all() concurrency + ordered synthesis",
  file: "examples/src/core/concurrency.tsx",
  code: REVIEW_CODE,
  nodes: [
    { id: "tool", label: "<Tool> read_source", x: 150, y: 30 },
    { id: "spec-a", label: "<Agent> correctness", x: 150, y: 100 },
    { id: "spec-b", label: "<Agent> maintainability", x: 420, y: 100 },
    { id: "synth", label: "<Agent> synthesize", x: 280, y: 185 },
    { id: "root", label: "<Review />", x: 280, y: 258 },
  ],
  edges: [
    { id: "e-root", from: "root", to: "synth" },
    { id: "e-a", from: "synth", to: "spec-a" },
    { id: "e-b", from: "synth", to: "spec-b" },
    { id: "e-tool", from: "spec-a", to: "tool" },
  ],
  events: [
    { at: 0, kind: "code", lines: [27] },
    { at: 0, kind: "trace", text: "evaluation:start tree=<Review />", tone: "info" },
    { at: 350, kind: "node", id: "root", state: "resolving" },
    { at: 350, kind: "code", lines: [3] },
    { at: 750, kind: "code", lines: [4] },
    { at: 900, kind: "node", id: "spec-a", state: "resolving" },
    { at: 900, kind: "edge", id: "e-a", state: "hot" },
    { at: 900, kind: "edge", id: "e-b", state: "hot" },
    { at: 900, kind: "code", lines: [5, 6] },
    { at: 1200, kind: "node", id: "tool", state: "resolving" },
    { at: 1200, kind: "code", lines: [7] },
    { at: 1500, kind: "node", id: "tool", state: "done" },
    { at: 1500, kind: "trace", text: "tool:grant read_source → correctness", tone: "ok" },
    { at: 1650, kind: "node", id: "spec-b", state: "resolving" },
    { at: 1650, kind: "code", lines: [12, 13] },
    { at: 1950, kind: "trace", text: "tool:grant read_source → maintainability", tone: "ok" },
    { at: 2150, kind: "node", id: "spec-a", state: "running" },
    { at: 2150, kind: "trace", text: "agent:start correctness provider=opencode", tone: "info" },
    { at: 2400, kind: "node", id: "spec-b", state: "running" },
    { at: 2400, kind: "trace", text: "agent:start maintainability provider=opencode", tone: "info" },
    { at: 2400, kind: "code", lines: [6, 12] },
    { at: 3300, kind: "trace", text: 'tool:call read_source path="src/index.ts"', tone: "info" },
    { at: 3550, kind: "trace", text: "tool:result 4_812 chars", tone: "ok" },
    { at: 4600, kind: "node", id: "spec-b", state: "done" },
    { at: 4600, kind: "edge", id: "e-b", state: "done" },
    { at: 4600, kind: "trace", text: "agent:done maintainability ms=2_200 (finishes first)", tone: "ok" },
    { at: 4600, kind: "code", lines: [6] },
    { at: 5400, kind: "node", id: "spec-a", state: "done" },
    { at: 5400, kind: "edge", id: "e-a", state: "done" },
    { at: 5400, kind: "trace", text: "agent:done correctness ms=3_250", tone: "ok" },
    { at: 5700, kind: "node", id: "synth", state: "resolving" },
    { at: 5700, kind: "code", lines: [19, 20] },
    { at: 5700, kind: "trace", text: "agent:prepare synthesize prompt += 2 results (authored order)", tone: "info" },
    { at: 6100, kind: "node", id: "synth", state: "running" },
    { at: 6100, kind: "trace", text: "agent:start synthesize provider=opencode", tone: "info" },
    { at: 6100, kind: "code", lines: [21, 22] },
    { at: 7900, kind: "node", id: "synth", state: "done" },
    { at: 7900, kind: "edge", id: "e-root", state: "done" },
    { at: 7900, kind: "trace", text: "agent:done synthesize ms=1_800", tone: "ok" },
    { at: 8100, kind: "node", id: "root", state: "done" },
    { at: 8100, kind: "code", lines: [27] },
    { at: 8100, kind: "trace", text: "evaluation:end ms=8_100 output=text", tone: "ok" },
    { at: 8300, kind: "output", text: REVIEW_OUTPUT },
  ],
  duration: 12400,
}

const LOOP_CODE = `import { Agent, Loop } from "@aml/sdk"
import { z } from "zod"

const ResearchState = z.object({
  done: z.boolean(),
  findings: z.array(z.string()),
})

<Loop
  name="research"
  initial={{ done: false, findings: [] }}
  schema={ResearchState}
  render={({ state }) => (
    <Agent provider={provider}>
      {state.done ? state.findings.join(", ") : "investigate"}
    </Agent>
  )}
/>`

const LOOP_OUTPUT = "final: state commits after this session"

const loop: Scenario = {
  id: "loop",
  tab: "loop until stable",
  title: "Transactional state across fresh sessions",
  file: "examples/src/core/loop.tsx",
  code: LOOP_CODE,
  nodes: [
    { id: "s1", label: "<Agent> session 1", x: 120, y: 40 },
    { id: "state", label: "state · schema-validated", x: 425, y: 40 },
    { id: "s2", label: "<Agent> session 2", x: 280, y: 140 },
    { id: "loop", label: "<Loop> research", x: 280, y: 248 },
  ],
  edges: [
    { id: "e-s1", from: "loop", to: "s1" },
    { id: "e-commit", from: "s1", to: "state" },
    { id: "e-carry", from: "state", to: "s2" },
    { id: "e-s2", from: "loop", to: "s2" },
  ],
  events: [
    { at: 0, kind: "code", lines: [9] },
    { at: 0, kind: "trace", text: "loop:start name=research schema=ResearchState", tone: "info" },
    { at: 350, kind: "node", id: "loop", state: "resolving" },
    { at: 350, kind: "code", lines: [11] },
    { at: 650, kind: "trace", text: "state:init { done: false, findings: [] }", tone: "info" },
    { at: 900, kind: "node", id: "s1", state: "resolving" },
    { at: 900, kind: "code", lines: [13, 14] },
    { at: 1200, kind: "node", id: "s1", state: "running" },
    { at: 1200, kind: "edge", id: "e-s1", state: "hot" },
    { at: 1200, kind: "trace", text: 'agent:start session=1 prompt="investigate"', tone: "info" },
    { at: 2500, kind: "code", lines: [15] },
    { at: 2500, kind: "trace", text: "tool:call aml_set_state", tone: "info" },
    { at: 2700, kind: "edge", id: "e-commit", state: "hot" },
    { at: 2700, kind: "node", id: "state", state: "resolving" },
    { at: 2850, kind: "trace", text: '  updates: { done: true, findings: ["state commits…"] }', tone: "info" },
    { at: 3200, kind: "node", id: "state", state: "done" },
    { at: 3200, kind: "edge", id: "e-commit", state: "done" },
    { at: 3200, kind: "trace", text: "state:commit ✓ valid against ResearchState", tone: "ok" },
    { at: 3400, kind: "node", id: "s1", state: "done" },
    { at: 3400, kind: "trace", text: "agent:done session=1 — stale text discarded, state advanced", tone: "ok" },
    { at: 3600, kind: "trace", text: "loop:iterate state changed → fresh session", tone: "info" },
    { at: 3800, kind: "node", id: "s2", state: "resolving" },
    { at: 3800, kind: "edge", id: "e-carry", state: "hot" },
    { at: 3800, kind: "code", lines: [15] },
    { at: 4100, kind: "node", id: "s2", state: "running" },
    { at: 4100, kind: "edge", id: "e-s2", state: "hot" },
    { at: 4100, kind: "trace", text: 'agent:start session=2 prompt="state commits after this session"', tone: "info" },
    { at: 4100, kind: "edge", id: "e-carry", state: "done" },
    { at: 5800, kind: "node", id: "s2", state: "done" },
    { at: 5800, kind: "edge", id: "e-s2", state: "done" },
    { at: 5800, kind: "trace", text: "agent:done session=2 ms=1_700 — no state change", tone: "ok" },
    { at: 6000, kind: "trace", text: "loop:terminate reason=state-stable iterations=2", tone: "info" },
    { at: 6200, kind: "node", id: "loop", state: "done" },
    { at: 6200, kind: "trace", text: "evaluation:end output=text", tone: "ok" },
    { at: 6400, kind: "output", text: LOOP_OUTPUT },
  ],
  duration: 7600,
}

const SANDBOX_CODE = `import { Agent, Sandbox } from "@aml/sdk"

export default function SandboxExample() {
  return (
    <Sandbox access="read-write" provider={Docker} root="repository">
      <Sandbox access="read-only" root="packages/api">
        <Agent provider={OpenCode} cwd="src">
          Inspect without modifying files.
        </Agent>
      </Sandbox>
    </Sandbox>
  )
}`

const SANDBOX_OUTPUT = `Inspected packages/api/src through lease-1.
The write never left the container.`

const sandbox: Scenario = {
  id: "sandbox",
  tab: "sandboxed inspection",
  title: "Nested policy narrowing over one shared lease",
  file: "examples/src/resources/sandbox.tsx",
  code: SANDBOX_CODE,
  nodes: [
    { id: "agent", label: "<Agent> opencode", x: 145, y: 40 },
    { id: "inner", label: "<Sandbox> read-only", x: 145, y: 130 },
    { id: "lease", label: "lease-1 · shared container", x: 425, y: 130 },
    { id: "outer", label: "<Sandbox> read-write", x: 280, y: 245 },
  ],
  edges: [
    { id: "e-inner", from: "outer", to: "inner" },
    { id: "e-lease", from: "outer", to: "lease" },
    { id: "e-agent", from: "inner", to: "agent" },
    { id: "e-share", from: "inner", to: "lease" },
  ],
  events: [
    { at: 0, kind: "code", lines: [5] },
    { at: 0, kind: "trace", text: "evaluation:start tree=<SandboxExample />", tone: "info" },
    { at: 350, kind: "node", id: "outer", state: "resolving" },
    { at: 700, kind: "trace", text: "sandbox:acquire provider=docker root=repository access=read-write", tone: "info" },
    { at: 950, kind: "node", id: "lease", state: "done" },
    { at: 950, kind: "edge", id: "e-lease", state: "done" },
    { at: 950, kind: "trace", text: "sandbox:lease lease-1 ready image=aml/sandbox:0", tone: "ok" },
    { at: 1150, kind: "node", id: "outer", state: "running" },
    { at: 1150, kind: "node", id: "inner", state: "resolving" },
    { at: 1150, kind: "code", lines: [6] },
    { at: 1450, kind: "trace", text: "sandbox:narrow root=packages/api access=read-only (reuses lease-1)", tone: "info" },
    { at: 1700, kind: "edge", id: "e-share", state: "done" },
    { at: 1700, kind: "node", id: "inner", state: "running" },
    { at: 1700, kind: "node", id: "agent", state: "resolving" },
    { at: 1700, kind: "code", lines: [7] },
    { at: 2000, kind: "node", id: "agent", state: "running" },
    { at: 2000, kind: "trace", text: "agent:start provider=opencode cwd=packages/api/src", tone: "info" },
    { at: 2700, kind: "trace", text: "fs:read src/routes.ts ✓ within policy", tone: "ok" },
    { at: 3200, kind: "trace", text: "fs:write src/routes.ts ✗ denied — sandbox is read-only", tone: "warn" },
    { at: 3450, kind: "trace", text: "agent continues with read-only findings", tone: "info" },
    { at: 4400, kind: "node", id: "agent", state: "done" },
    { at: 4400, kind: "trace", text: "agent:done — Inspected packages/api/src through lease-1", tone: "ok" },
    { at: 4700, kind: "node", id: "inner", state: "done" },
    { at: 4700, kind: "edge", id: "e-agent", state: "done" },
    { at: 4700, kind: "trace", text: "sandbox:release scope=packages/api", tone: "info" },
    { at: 5000, kind: "node", id: "outer", state: "done" },
    { at: 5000, kind: "trace", text: "sandbox:release lease-1 (container stopped)", tone: "info" },
    { at: 5250, kind: "trace", text: "evaluation:end output=text", tone: "ok" },
    { at: 5450, kind: "output", text: SANDBOX_OUTPUT },
  ],
  duration: 7400,
}

const AGENT_CODE = `import { Agent, Skill, System, Tool } from "@aml/sdk"

const notes = (
  <Agent provider={OpenCode}>
    <System>You are a meticulous release engineer.</System>
    <Skill>Prefer small, reversible changes.</Skill>
    <Tool use={ReadChangelog} />
    <Tool use={CreateTag} />
    Draft the v0.4.0 release notes.
  </Agent>
)

console.log(await runtime.evaluate(notes))`

const AGENT_OUTPUT = `v0.4.0 — parallel specialist reviews, structured outputs, sandbox policy narrowing.
14 commits since v0.3.0 · tag v0.4.0 created.`

const agent: Scenario = {
  id: "agent",
  tab: "hello, agent",
  title: "One session — system, skill, two tools",
  file: "your-first-agent.tsx",
  code: AGENT_CODE,
  nodes: [
    { id: "system", label: "<System>", x: 80, y: 56 },
    { id: "skill", label: "<Skill>", x: 215, y: 56 },
    { id: "tool-a", label: "<Tool> changelog", x: 345, y: 56 },
    { id: "tool-b", label: "<Tool> create_tag", x: 480, y: 56 },
    { id: "agent", label: "<Agent> release notes", x: 280, y: 196 },
  ],
  edges: [
    { id: "e-system", from: "agent", to: "system" },
    { id: "e-skill", from: "agent", to: "skill" },
    { id: "e-a", from: "agent", to: "tool-a" },
    { id: "e-b", from: "agent", to: "tool-b" },
  ],
  events: [
    { at: 0, kind: "code", lines: [13] },
    { at: 0, kind: "trace", text: "evaluation:start tree=notes", tone: "info" },
    { at: 300, kind: "node", id: "agent", state: "resolving" },
    { at: 300, kind: "code", lines: [3] },
    { at: 600, kind: "node", id: "system", state: "resolving" },
    { at: 600, kind: "code", lines: [4] },
    { at: 900, kind: "node", id: "system", state: "done" },
    { at: 900, kind: "trace", text: "system:compose 1 block", tone: "ok" },
    { at: 950, kind: "node", id: "skill", state: "resolving" },
    { at: 950, kind: "code", lines: [5] },
    { at: 1250, kind: "node", id: "skill", state: "done" },
    { at: 1250, kind: "trace", text: "skill:attach 1 instruction set", tone: "ok" },
    { at: 1300, kind: "node", id: "tool-a", state: "resolving" },
    { at: 1300, kind: "code", lines: [6] },
    { at: 1600, kind: "node", id: "tool-a", state: "done" },
    { at: 1600, kind: "trace", text: "tool:grant read_changelog", tone: "ok" },
    { at: 1650, kind: "node", id: "tool-b", state: "resolving" },
    { at: 1650, kind: "code", lines: [7] },
    { at: 1950, kind: "node", id: "tool-b", state: "done" },
    { at: 1950, kind: "trace", text: "tool:grant create_tag", tone: "ok" },
    { at: 2200, kind: "code", lines: [8] },
    { at: 2200, kind: "trace", text: 'prompt:resolve "Draft the v0.4.0 release notes."', tone: "info" },
    { at: 2500, kind: "node", id: "agent", state: "running" },
    { at: 2500, kind: "edge", id: "e-system", state: "hot" },
    { at: 2500, kind: "edge", id: "e-skill", state: "hot" },
    { at: 2500, kind: "edge", id: "e-a", state: "hot" },
    { at: 2500, kind: "edge", id: "e-b", state: "hot" },
    { at: 2500, kind: "trace", text: "agent:start provider=opencode tools=2", tone: "info" },
    { at: 3300, kind: "trace", text: "tool:call read_changelog", tone: "info" },
    { at: 3600, kind: "trace", text: "tool:result 812 chars", tone: "ok" },
    { at: 4100, kind: "trace", text: 'tool:call create_tag name="v0.4.0"', tone: "info" },
    { at: 4400, kind: "trace", text: "tool:result tag created", tone: "ok" },
    { at: 5000, kind: "node", id: "agent", state: "done" },
    { at: 5000, kind: "edge", id: "e-system", state: "done" },
    { at: 5000, kind: "edge", id: "e-skill", state: "done" },
    { at: 5000, kind: "edge", id: "e-a", state: "done" },
    { at: 5000, kind: "edge", id: "e-b", state: "done" },
    { at: 5000, kind: "code", lines: [13] },
    { at: 5000, kind: "trace", text: "agent:done ms=2_500", tone: "ok" },
    { at: 5250, kind: "trace", text: "evaluation:end output=text", tone: "ok" },
    { at: 5450, kind: "output", text: AGENT_OUTPUT },
  ],
  duration: 8100,
}

// Loop remains a draft design target and is intentionally not shown in the public playground.
export const SCENARIOS: readonly Scenario[] = [agent, review, sandbox]
