# Capabilities and resources

## JavaScript tools

`defineTool()` returns one typed callable with a Standard Schema-compatible input. Call it from an active component when application code chooses the operation; pass the same identity to `<Tool use>` only when the model should receive that capability. Add an output schema when the Tool's result also needs validation:

```tsx
import { readFile } from "node:fs/promises"

import { Agent, defineTool, Tool } from "@aml-jsx/sdk"
import { z } from "zod"

const ReadSource = defineTool({
  name: "read_source",
  description: "Read one source file from the current project",
  input: z.object({ path: z.string() }),
  output: z.string(),
  execute: async ({ path }) => await readFile(path, "utf8"),
})

async function LoadSource() {
  return await ReadSource({ path: "src/index.ts" })
}

const SourceAgent = (
  <Agent provider={OpenCode}>
    <Tool use={ReadSource} />
    Read src/index.ts and summarize it.
  </Agent>
)
```

The authored `execute(input, context)` callback receives invocation-scoped cancellation and trace state for both application and model-selected calls. The returned Tool's public `.execute(input, context)` method is the explicit low-level provider/test API; application components use the callable form. Do not capture mutable global execution state.

Native repository reads, edits, shell commands, and network access belong to the coding Agent rather than `<Tool>`.
They default optimistically on and can be narrowed with `<Agent permissions={...}>`. Profiles map those requests to
their native controls where possible; the active Sandbox remains the authoritative security boundary.

## MCP servers

Define explicit MCP transport configuration once:

```tsx
import { Agent, defineMcpServer, Mcp } from "@aml-jsx/sdk"

const linearToken = process.env.LINEAR_TOKEN
if (!linearToken) throw new Error("LINEAR_TOKEN is required")

const Linear = defineMcpServer({
  name: "linear",
  transport: {
    type: "streamable-http",
    url: "https://example.com/mcp",
    headers: { Authorization: `Bearer ${linearToken}` },
  },
})

<Agent provider={OpenCode}>
  <Mcp use={Linear} />
  Gather this week's Linear updates.
</Agent>
```

The supported explicit transports are:

- `streamable-http` with an absolute HTTP(S) URL and optional headers.
- `stdio` with a command and optional args, cwd, and environment.

Use `<Mcp name="...">` only for a provider-native MCP name already configured in that provider's environment.

## Authoring files and Skills

Use `<Include>` for prompt content and `<Skill>` for a real Agent Skill package:

```tsx
import { Agent, Block, File, Include, Sandbox, Skill, Workspace } from "@aml-jsx/sdk"

;<Workspace provider={Project}>
  <File path="brief.md">Review the authentication boundary.</File>
  <Sandbox provider={Docker}>
    <Agent provider={OpenCode}>
      <Skill src="./skills/code-review" />
      <Block>
        <Include path="brief.md" maxBytes={4_000} />
      </Block>
      Complete the review.
    </Agent>
  </Sandbox>
</Workspace>
```

`<Include src>` reads an application-owned UTF-8 file live relative to the runtime `cwd`. `<Include path>` reads the nearest active filesystem: the Sandbox guest when present, otherwise the Workspace materialization. `maxBytes` inlines small files and emits a read instruction for larger files; AML automatically stages an oversized local `src` at an Agent-visible path. Use `title={false}` only when the surrounding prompt already supplies its own structure.

`<File>` accepts exactly one source: resolved children or local `src`. It writes through the nearest active filesystem and contributes no prompt text. Lexical placement selects Workspace or Sandbox ownership; do not add routing props.

`<Skill src>` expects a local package directory containing `SKILL.md`. AML validates and stages the complete package under the `.agents/skills/<name>/` suffix of a writable Agent-visible staging root, uses native provider discovery when available, and otherwise adds only metadata containing the concrete path. Skill is session-wide, must be declared at Agent level, and never inlines its body automatically. AML does not fetch registries, install remote packages, or run package scripts.

Keep secrets and dynamic credentials out of Include, File, and Skill content.

## Sandboxes

Use `<Sandbox>` to acquire and scope ephemeral execution:

```tsx
import { Agent, dockerSandbox, Sandbox } from "@aml-jsx/sdk"

const Docker = dockerSandbox({ image: "node:26-alpine" })

<Sandbox provider={Docker} access="read-only" root="repository">
  <Agent provider={OpenCode} cwd="src">
    Inspect the implementation without modifying files.
  </Agent>
</Sandbox>
```

An outer Sandbox acquires a lease. A nested Sandbox narrows the active lease; it does not acquire a second environment. Make access, root, network, and provider compatibility explicit.

Sandbox images and snapshots own their installed Agents and tools. AML does not build images or silently install dependencies. For experiments, provider factories may expose an explicit `setup` command that runs after the Workspace is visible and before the Agent starts.

Fetch the [Sandbox image guide](https://agent-markup-language.com/docs/sandbox-images.md) before choosing the AML `full` image, a single-Agent stable variant, the bleeding-edge GHCR `dev` image, or a derived project image.

Built-in coding Agents launch through `SandboxRuntime.spawn()` and the shared ACP engine. Portable File, Include, and Agent staging use the runtime's stat, complete-file read, and atomic replacement write methods rather than shell commands. A provider must never fall back to a host SDK, embedded loop, or one-shot CLI when a Sandbox is active.

Remote providers keep their vendor configuration shapes:

```ts
const Daytona = daytonaSandbox({
  config: { apiKey: process.env.DAYTONA_API_KEY },
  setup: "agent --version",
  snapshot: "aml-agents",
})
```

Daytona transfers the selected Workspace into the remote environment and reconciles the complete writable tree before release. Its first implementation requires `tar` in both the AML host and selected Daytona image or snapshot.

Modal keeps the same Workspace contract while preserving its native client and Sandbox creation options:

```ts
const Modal = modalSandbox({
  config: {
    tokenId: process.env.MODAL_TOKEN_ID,
    tokenSecret: process.env.MODAL_TOKEN_SECRET,
  },
  create: { cpu: 2, timeoutMs: 300_000 },
  image: "node:26",
})
```

Modal transfers the selected Workspace into `/workspace`, bounds combined command output, reconciles the complete writable tree, and terminates the Sandbox on release. The selected image and AML host must include `tar`; read-only execution is rejected because archive transfer does not produce a read-only guest mount.

## Workspaces

Use `<Workspace>` when files must persist across disposable Sandbox leases:

```tsx
import { Agent, localWorkspace, Sandbox, Workspace } from "@aml-jsx/sdk"

const Project = localWorkspace({ directory: "/absolute/path/to/project" })

<Workspace id="review-42" provider={Project}>
  <Sandbox provider={Docker} access="read-write">
    <Agent provider={OpenCode}>Write findings.md.</Agent>
  </Sandbox>
  <Sandbox provider={Docker} access="read-only">
    <Agent provider={Codex}>Review findings.md.</Agent>
  </Sandbox>
</Workspace>
```

A Workspace provides durable materialization and identity. A Sandbox provides execution isolation. Use both only when the workflow needs both responsibilities. File and Include select the nearest active filesystem, while Skill staging remains invocation-owned and ephemeral unless the application deliberately authors the same package into durable Workspace content.

## Scope rules

- Tool, MCP, Skill, and FollowUp declarations belong to their nearest Agent.
- Capability grants do not leak into sibling Agents.
- Sandbox and Workspace state flows downward through descendants.
- Provider-specific support still matters: a declared capability or resource must be supported by the selected Agent provider.
