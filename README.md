# Agent Markup Language

<img width="1343" height="682" alt="image" src="https://github.com/user-attachments/assets/602775fc-7f61-4d0a-bd0f-40c0585f015f" />

Agent Markup Language (AML) is an asynchronous TypeScript and JSX runtime for composing provider-agnostic agent workflows.

AML lets you describe agents, prompts, capabilities, execution environments, durable workspaces, and multi-step control flow as one executable tree. The runtime resolves that tree from the leaves upward, manages provider and resource lifecycles, and returns the final Agent output as text or validated structured data.

> AML is under active development. Public package APIs and examples may change before the first stable release.

## Why AML

Agent SDKs are good at running one provider session. Real workflows usually need more: parallel specialists, ordered synthesis, shared context, custom JavaScript tools, model-specific adapters, sandbox boundaries, durable files, follow-up turns, and useful traces.

Without a shared runtime, those concerns become orchestration code tied to one provider. AML keeps the workflow declarative and uses the Agent Client Protocol (ACP) as the canonical session boundary for built-in coding agents.

When an `<Agent />` node resolves, the AML Runtime preloads its `<Workspace />` into the selected `<Sandbox />` and prompts the coding Agent through ACP. The Workspace keeps files durable between runs; the Sandbox owns code execution, filesystem access, and permissions.

```text
AML tree
  ├─ resolve components and context
  ├─ acquire Workspace and Sandbox resources
  ├─ run independent Agents through injected providers
  ├─ carry their results into parent prompts
  └─ release resources and return the final output
```

Ordinary JSX children resolve in authored order. Independent work becomes concurrent only when the component explicitly starts it with JavaScript primitives such as `Promise.all()`.

## Example

Configure TypeScript to use AML's automatic JSX runtime:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@aml-jsx/sdk"
  }
}
```

Then compose ordinary async components, Agents, and typed JavaScript Tools:

```tsx
import { readFile } from "node:fs/promises"

import { Agent, AmlRuntime, createConsoleTracer, defineTool, evaluate, opencodeAgent, Tool } from "@aml-jsx/sdk"
import { z } from "zod"

const OpenCode = opencodeAgent({})

const ReadSource = defineTool({
  name: "read_source",
  description: "Read one source file from the current project",
  input: z.object({ path: z.string() }),
  execute: async ({ path }) => await readFile(path, "utf8"),
})

async function Review() {
  const [correctness, maintainability] = await Promise.all([
    evaluate(
      <Agent provider={OpenCode} system="Find concrete correctness defects.">
        <Tool use={ReadSource} />
        Review src/index.ts.
      </Agent>
    ),
    evaluate(
      <Agent provider={OpenCode} system="Find proportionate maintainability improvements.">
        <Tool use={ReadSource} />
        Review src/index.ts.
      </Agent>
    ),
  ])

  return (
    <Agent provider={OpenCode} system="Synthesize evidence without inventing findings.">
      Correctness:
      {correctness}
      Maintainability:
      {maintainability}
    </Agent>
  )
}

const runtime = new AmlRuntime()
runtime.on("trace", createConsoleTracer())

console.log(await runtime.evaluate(<Review />))
```

The workflow stays the same when the provider changes. Replace `OpenCode` with a Codex, GitHub Copilot, GLM, or Pi provider without rewriting the AML tree:

```tsx
import { piAgent } from "@aml-jsx/sdk"

const Pi = piAgent({
  env: { OPENCODE_API_KEY: process.env.OPENCODE_API_KEY ?? "" },
  model: "opencode-go/glm-5.1",
})
```

Codex, GitHub Copilot, GLM, OpenCode, and Pi use compatible ACP Agent executables. Their normal public factories are thin profiles over one shared session engine, so changing the provider does not select a different local-versus-Sandbox lifecycle. GLM uses the community-maintained `glm-acp-agent` adapter, not Z.ai's ZCode harness. The selected host, image, snapshot, or package set must contain the compatible executable; AML does not install Agents implicitly.

## Coding agents

Install the repository's `aml-jsx` skill to give supported coding agents the current AML authoring patterns, runtime
semantics, provider guidance, and testing conventions:

```sh
npx skills add we-are-singular/aml --skill aml-jsx
```

The command installs the skill into the current project. Add `-g` to make it available globally. The skill is stored
in [`skills/aml-jsx`](./skills/aml-jsx) and should be used whenever an agent builds, explains, tests, or debugs
workflows with `@aml-jsx/sdk`.

## Primitives

| Primitive     | Purpose                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `<Agent>`     | Runs one Agent session and optionally validates its result with an Agent-owned `schema`.                             |
| `<System>`    | Adds resolved content to the owning Agent's system prompt. Multiple System blocks are joined in authored order.      |
| `<Tool>`      | Grants the owning Agent a JavaScript Tool created with `defineTool()`.                                               |
| `<Skill>`     | Adds reusable inline or local-file instructions to the owning Agent.                                                 |
| `<File>`      | Writes resolved text, including Agent output, beneath the active Workspace before later siblings run.                |
| `<Mcp>`       | Grants the owning Agent a provider-native MCP server by name or an explicit server created with `defineMcpServer()`. |
| `<FollowUp>`  | Adds a later turn to the same Agent session. FollowUps are flat, ordered, and resolved before the session starts.    |
| `<Sandbox>`   | Acquires an ephemeral execution environment and scopes a narrowed filesystem policy to descendant Agents.            |
| `<Script>`    | Executes resolved source or one literal command on the host or in the active Sandbox and returns standard output.    |
| `<Workspace>` | Materializes durable files that can survive and be shared across disposable Sandbox leases.                          |
| `<>...</>`    | Groups AML values without adding prompt text or another runtime boundary.                                            |

## Core APIs

| API                                   | Purpose                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `AmlRuntime`                          | Evaluates a complete AML tree, owns budgets and lifecycle events, and returns the final text output.             |
| `ProcessSignalCancellation`           | Converts application-owned SIGINT/SIGTERM handling into bounded runtime cancellation.                            |
| `evaluate()`                          | Evaluates AML from inside an active component and returns text or schema-validated structured data.              |
| `defineTool()`                        | Turns a JavaScript function into a model-callable capability with validated input and optional validated output. |
| `defineMcpServer()`                   | Creates an immutable provider-neutral MCP descriptor for a local stdio process or remote Streamable HTTP server. |
| `defineAgentProvider()`               | Defines an Agent harness adapter implementing AML's provider contract.                                           |
| `AbstractAgentProvider`               | Optional lifecycle template for custom structural providers outside the built-in ACP path.                       |
| `AgentProviderSession`                | Narrow invocation session available to custom providers using that lifecycle template.                           |
| `createAgentProviderTurns()`          | Validates and captures ordered initial and FollowUp turns for a provider session.                                |
| `executeAgentProviderSession()`       | Executes a captured session with shared cancellation, result selection, and cleanup semantics.                   |
| `defineSandboxProvider()`             | Defines an ephemeral execution provider.                                                                         |
| `AbstractSandboxProvider`             | Optional template for staged Sandbox provisioning, initialization, compensation, and release.                    |
| `ProvisionedSandbox`                  | Acknowledged provider resource used by the Sandbox lifecycle template for compensation and release.              |
| `SandboxCommand`                      | Captures and validates one portable literal Sandbox command before backend translation.                          |
| `defineWorkspaceProvider()`           | Defines a durable filesystem materialization provider.                                                           |
| `createPersistentWorkspaceProvider()` | Builds revision persistence over a user-defined `WorkspaceStorageAdapter`.                                       |
| `runtime.on()` / `runtime.once()`     | Subscribes to evaluation lifecycle and trace events.                                                             |

### Experimental APIs

`<Loop>`, `<Context.Provider>`, `createContext()`, and `useContext()` are implemented and exported for evaluation, but they are not yet stable release-ready contracts. They may change while their semantics are being evaluated.

## Providers

The public SDK includes the runtime, built-in integrations, and testing utilities under one package.

| Role      | Source                                           | Public export           | Notes                                                                                                                                                                                                |
| --------- | ------------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent     | [OpenCode adapter](./providers/agents/opencode)  | `opencodeAgent()`       | OpenCode ACP profile with model/system mapping and native capability metadata.                                                                                                                       |
| Agent     | [Codex adapter](./providers/agents/codex)        | `codexAgent()`          | Codex ACP profile using the maintained Codex ACP adapter.                                                                                                                                            |
| Agent     | [Copilot adapter](./providers/agents/copilot)    | `copilotAgent()`        | GitHub Copilot CLI profile using its native ACP server and invocation-private Copilot state.                                                                                                         |
| Agent     | [GLM adapter](./providers/agents/glm)            | `glmAgent()`            | Community `glm-acp-agent` profile for Z.ai Coding Plan models; this is not the ZCode harness.                                                                                                        |
| Agent     | [Pi adapter](./providers/agents/pi)              | `piAgent()`             | Pi ACP profile using the maintained Pi ACP adapter.                                                                                                                                                  |
| Sandbox   | [Local adapter](./providers/sandboxes/local)     | `localSandbox()`        | Runs the common Sandbox runtime as trusted host processes for development; it is explicitly non-isolating.                                                                                           |
| Sandbox   | [Docker adapter](./providers/sandboxes/docker)   | `dockerSandbox()`       | Starts AML's default Agent image or an override, mounts the Workspace, and exposes the common bounded command runtime without building the image.                                                    |
| Sandbox   | [Daytona adapter](./providers/sandboxes/daytona) | `daytonaSandbox()`      | Creates AML's default Agent image or an explicit Daytona image/snapshot, transfers the Workspace, reconciles writable changes, and deletes the remote Sandbox.                                       |
| Sandbox   | [Modal adapter](./providers/sandboxes/modal)     | `modalSandbox()`        | Creates a Modal Sandbox from AML's default Agent image or a registry override, transfers the Workspace, reconciles writable changes, and terminates it.                                              |
| Workspace | [Local adapter](./providers/workspaces/local)    | `localWorkspace()`      | Uses an existing local directory as a durable Workspace with cross-process writer locking.                                                                                                           |
| Workspace | [Local adapter](./providers/workspaces/local)    | `filesystemWorkspace()` | Stages archive or folder revisions from a durable local filesystem store into a safe temporary materialization.                                                                                      |
| Workspace | [S3 adapter](./providers/workspaces/s3)          | `s3Workspace()`         | Restores and publishes immutable archive or folder revisions through S3-compatible storage. R2 has repository smoke evidence; other backends require deployment-specific compatibility verification. |
| Testing   | [Testing entry](./sdk/src/testing.ts)            | `@aml-jsx/sdk/testing`  | Supplies deterministic Agent, Sandbox, and Workspace providers plus reusable conformance suites.                                                                                                     |

The credentialed smoke runner exercises the complete built-in Agent × Sandbox matrix:

| Sandbox \ Agent | Codex | Copilot | GLM | OpenCode | Pi  |
| --------------- | ----- | ------- | --- | -------- | --- |
| Local           | Yes   | Yes     | Yes | Yes      | Yes |
| Docker          | Yes   | Yes     | Yes | Yes      | Yes |
| Daytona         | Yes   | Yes     | Yes | Yes      | Yes |
| Modal           | Yes   | Yes     | Yes | Yes      | Yes |

Every cell launches its Agent through the same shared ACP engine and `SandboxRuntime.spawn()`. These proofs use read-write Workspaces where a provider cannot enforce read-only access. The selected host, image, or snapshot must contain the required executable. Sandbox providers do not install Agents implicitly.

Docker, Daytona, and Modal smoke cells use `ghcr.io/we-are-singular/aml-agent-sandbox:dev`. Set `AML_SMOKE_SANDBOX_IMAGE` to run every image-backed cell against one explicit reference, such as an immutable version or digest. Provider factories default to `wearesingular/aml-agent-sandbox:latest`; applications can override it with their own image or snapshot.

`<System>`, `<Skill>`, `<FollowUp>`, Context, and tree evaluation are runtime-owned. JavaScript Tools use one AML-owned invocation MCP bridge. Structured output uses one AML-owned submission Tool on the final authored turn and one shared, schema-bearing repair prompt if that turn omits the Tool call. Agent permissions default to read-write filesystem, shell, and network access; the active Sandbox remains the security boundary for model-controlled operations.

Provider factories retain typed vendor configuration and process environment inputs. Credentials normally remain in the selected host or Sandbox environment; an application may also pass explicit invocation environment variables without changing the AML tree.

Sandbox factories keep environment identity at the factory root: Docker and Modal accept an optional `image`, while Daytona accepts either `image` or `snapshot`. Omitting those selectors uses `wearesingular/aml-agent-sandbox:latest`. Daytona's `create` retains its remaining image- or snapshot-specific creation parameters, and Modal's `create` retains its native Sandbox creation options. AML does not build images or silently install Agents. Each Sandbox may run an explicit trusted `setup` command after its Workspace is visible.

The S3 Workspace factory accepts an injected `S3Client` or its native client configuration. A local MinIO instance uses the same provider with an endpoint and path-style addressing:

```ts
const workspace = s3Workspace({
  bucket: "aml-workspaces",
  config: {
    credentials: {
      accessKeyId: "aml-minio",
      secretAccessKey: "aml-minio-secret",
    },
    endpoint: "http://127.0.0.1:19000",
    forcePathStyle: true,
    region: "us-east-1",
  },
})
```

Each revision-backed Workspace identity has an atomic `workspace.json` index and immutable revisions. `lock` defaults
to `true`, so one evaluation owns that identity until save and release; built-in locks use a fixed five-minute
heartbeat and become recoverable after twenty minutes without renewal. `lock={false}` permits concurrent
materializations, while conditional index publication prevents a stale save from overwriting committed state.
`format` is `"archive" | "folder"` and defaults to archive. The shared persistence engine—not the S3 or filesystem
adapter—owns selection, `.gitignore`, tar handling, folder manifests, retention, and revision publication.

`File` can turn a child Agent result into a durable handoff without duplicating that text into the surrounding
prompt. An unsandboxed `Script` runs as a trusted host process from the runtime cwd. Its optional portable `cwd`
resolves from that runtime cwd; inside a Sandbox it resolves from the active Sandbox root. `Workspace` supplies the
default logical cwd for descendant Sandboxes, and a Script inside one always uses that Sandbox runtime:

```tsx
const status = await new AmlRuntime().evaluate(<Script cwd="apps/cli" command="git" args={["status", "--short"]} />)
```

```tsx
<Workspace
  cwd="repo"
  id="review-42"
  load={{ revision: "current" }}
  lock
  provider={workspace}
  save={{
    include: ["repo/src/**", "repo/tests/**", "report.md"],
    exclude: ["**/node_modules/**"],
  }}
  writeConcurrency="serial"
>
  <File path="task.md">
    <Agent provider={planner}>Write a focused implementation task.</Agent>
  </File>

  <Sandbox access="read-write" provider={sandbox}>
    <Script command="git" args={["status", "--short"]} />

    <Script shell="node">{`import { writeFileSync } from "node:fs"; writeFileSync("ready.txt", "yes")`}</Script>

    <Agent provider={builder}>Read task.md, implement it, and write report.md.</Agent>
  </Sandbox>
</Workspace>
```

`id` defaults to `crypto.randomUUID()`, `cwd` and current-revision loading default to `"."` and enabled respectively,
locking defaults to enabled, writable Sandbox concurrency defaults to `"serial"`, and saving defaults to disabled.
Serial mode waits before acquiring another writable root Sandbox, so transferred Sandboxes hydrate only after the
previous writer reconciles. Read-only Sandboxes and agents sharing one Sandbox can still run concurrently.
`writeConcurrency="parallel"` is intended for shared mounts; transferred snapshots can overwrite one another.
`save: true` discovers the tree subject to `.gitignore`, publishes after success, and retains one revision. Explicit
include patterns override `.gitignore`; excludes always win. `save={{ on: "always" }}` also publishes failed work,
while cancellation never saves.

## Examples

Every example is one self-contained AML component. Run one with `npm run example -- <name>`.

| Example                                                                  | Description                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [`basic`](./examples/src/core/basic.tsx)                                 | Resolves ordinary synchronous and asynchronous JSX components from the leaves upward.                  |
| [`agent`](./examples/src/core/agent.tsx)                                 | Uses a child Agent to generate System content for its parent.                                          |
| [`concurrency`](./examples/src/core/concurrency.tsx)                     | Runs two specialists concurrently and preserves authored result order for synthesis.                   |
| [`structured`](./examples/src/core/structured.tsx)                       | Passes schema-validated Agent data into a later text-producing Agent.                                  |
| [`context`](./examples/src/core/context.tsx)                             | Injects a session repository and captures it inside a JavaScript Tool without adding it to the prompt. |
| [`follow-up`](./examples/src/core/follow-up.tsx)                         | Authors several turns inside one Agent session.                                                        |
| [`skill`](./examples/src/capabilities/skill.tsx)                         | Adds reusable inline instructions to an Agent.                                                         |
| [`mcp`](./examples/src/capabilities/mcp.tsx)                             | Grants one Agent an MCP server while proving sibling capability isolation.                             |
| [`sandbox`](./examples/src/resources/sandbox.tsx)                        | Narrows nested Sandbox access while sharing one deterministic outer lease.                             |
| [`script`](./examples/src/resources/script.tsx)                          | Selects a Script working directory relative to the active Sandbox root.                                |
| [`workspace`](./examples/src/resources/workspace.tsx)                    | Shares one durable materialization across disposable Sandbox leases.                                   |
| [`opencode`](./examples/src/integrations/opencode.tsx)                   | Uses a credentialed OpenCode model to call a process-local JavaScript Tool.                            |
| [`pi`](./examples/src/integrations/pi.tsx)                               | Embeds Pi with an OpenCode Go model and calls a process-local JavaScript Tool.                         |
| [`review`](./examples/src/integrations/review.tsx)                       | Runs a parallel multi-agent code review through deterministic, OpenCode, or Codex providers.           |
| [`docker`](./examples/src/integrations/docker.tsx)                       | Inspects a real Docker Sandbox's working directory and confinement settings.                           |
| [`modal`](./examples/src/integrations/modal.tsx)                         | Inspects a real Modal Sandbox through the common bounded runtime.                                      |
| [`workspace-local`](./examples/src/integrations/workspace-local.tsx)     | Persists a file across disposable Sandbox runs through the local Workspace provider.                   |
| [`workspace-routing`](./examples/src/integrations/workspace-routing.tsx) | Uses typed Agent output to select a local Workspace and pass a normalized task to a second Agent.      |

The deterministic examples are snapshot-tested. Live model, Docker, and filesystem integrations are opt-in.

## Repository layout

```text
sdk/        @aml-jsx/sdk, the AML runtime and public API
providers/  optional Agent, Sandbox, and Workspace provider implementations
apps/       runnable products built on AML (website: the project site)
examples/   human-readable client workflows
```

[`SPEC.md`](./SPEC.md) is the normative behavior contract. [`PRD.md`](./PRD.md) records product decisions, architecture, and delivery status. [`PROVIDERS.md`](./PROVIDERS.md) tracks the provider implementation wishlist.

## Development

Requirements:

- Node.js 26 or newer
- npm 11 or newer
- Docker for Docker integration tests, examples, and the local MinIO integration
- Configured Codex, GitHub Copilot, GLM, OpenCode, or Pi-supported model-provider credentials only for live Agent examples

Install dependencies:

```sh
npm install
```

Common commands:

| Command                                                       | Purpose                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| `npm run format`                                              | Format supported repository files with Oxfmt.                   |
| `npm run format:check`                                        | Verify formatting without changing files.                       |
| `npm run lint`                                                | Type-check and lint every workspace.                            |
| `npm run test`                                                | Run deterministic tests across every workspace.                 |
| `npm run build`                                               | Build every distributable package.                              |
| `npm run pack:check`                                          | Validate built exports, packed files, and provider conformance. |
| `npm run example -- basic`                                    | Run one example through built package exports.                  |
| `npm run example -- review`                                   | Run the review workflow with its deterministic provider.        |
| `AML_REVIEW_PROVIDER=opencode npm run example -- review`      | Run the review workflow through OpenCode.                       |
| `AML_REVIEW_PROVIDER=codex npm run example -- review`         | Run the review workflow through Codex.                          |
| `npm run example -- pi`                                       | Run Pi through its ACP adapter and configured credentials.      |
| `npm run example -- docker`                                   | Run the real Docker Sandbox example.                            |
| `npm run smoke -- --agent pi --sandbox daytona`               | Run one Agent × Sandbox smoke matrix cell with live traces.     |
| `npm run smoke -- --agent codex`                              | Run one Agent against every registered Sandbox.                 |
| `npm run smoke -- --sandbox docker`                           | Run every registered Agent against one Sandbox.                 |
| `npm run smoke:kitchen-sink`                                  | Run all stable primitives through R2, OpenCode, and Modal.      |
| `npx vite-node sdk/tests/smoke/workspace-s3-chain.smoke.tsx`  | Run the Docker → Daytona → S3 Workspace persistence proof.      |
| `npm run test:integration --workspace=@aml-jsx/sandbox-modal` | Run Modal's credentialed Workspace round-trip proof.            |
| `npm run smoke -- --list`                                     | List the complete or filtered matrix without executing it.      |

Package-specific integration suites are available through their workspace scripts:

```sh
npm run test:integration --workspace=@aml-jsx/agent-opencode
npm run test:integration --workspace=@aml-jsx/agent-codex
npm run test:integration --workspace=@aml-jsx/agent-glm
npm run test:integration --workspace=@aml-jsx/agent-pi
npm run test:integration --workspace=@aml-jsx/sandbox-docker
docker compose up -d --wait minio
npm run test:integration --workspace=@aml-jsx/workspace-s3
docker compose down
```

### Smoke tests

Matrix smoke files use a dedicated Vitest configuration and stay outside default unit tests. Omitting both matrix filters runs every registered Agent against every registered Sandbox. npm requires the `--` separator before smoke-runner options.

The manual kitchen-sink smoke defaults to `--agent opencode --sandbox modal --workspace r2 --mcp context7`. It accepts any registered Agent or Sandbox, plus `local | r2` Workspaces and `context7 | none` MCP selection. The workflow exercises all eleven stable primitives, then reacquires the saved Workspace and verifies the persisted files. Run `npm run smoke:kitchen-sink -- --help` for the current selections. Context7 supports anonymous testing; `CONTEXT7_API_KEY` raises its rate limit when configured.

The smoke runners load the repository's untracked `.env`. Codex, OpenCode, and Pi use `OPENAI_API_KEY` or `AML_CODEX_API_KEY`; `AML_CODEX_MODEL`, `AML_OPENCODE_MODEL`, and `AML_PI_MODEL` may override their models. Copilot uses `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` in that order and defaults to `gpt-5-mini`; `AML_COPILOT_GITHUB_TOKEN` and `AML_COPILOT_MODEL` are optional smoke-only overrides. GLM uses `Z_AI_API_KEY` or `AML_ZAI_API_KEY` and defaults to `glm-5.3`; `AML_GLM_MODEL` may override its model. Daytona uses `DAYTONA_API_KEY`. Modal uses the repository-local `MODAL_API_KEY` and `MODAL_API_SECRET` names as `tokenId` and `tokenSecret`; Modal's own ambient credential names remain `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`. The R2 Workspace accepts `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`, with the existing `AML_S3_*` aliases. These environment names configure only the repository's smoke CLI. Applications configure providers through their native factory options and runtime environment.

The full matrix and the default kitchen sink are manual release gates. Run both before every package release, and always before a major-version release:

```sh
npm run smoke
npm run smoke:kitchen-sink
```

They intentionally stay outside CI and `npm run release:check` because they consume paid model inference and may provision billable remote Sandbox and Workspace infrastructure. A green deterministic CI run does not replace these live compatibility and composition proofs.

Commits are checked with lint-staged and commitlint. Pushes run the same formatting, linting, test, and build
contract enforced by GitHub Actions.

## Releasing

SDK, CLI, and image releases are manual and independent. Complete the [manual smoke tests](#smoke-tests), start from a
clean `main` that matches `origin/main`, authenticate with the required registries and GitHub, then run the interactive
release for the intended package:

```sh
npm login
GITHUB_TOKEN="$(gh auth token)" npm run release:sdk
GITHUB_TOKEN="$(gh auth token)" npm run release:cli
npm run release:sandbox
```

`npm run release` remains an alias for `release:sdk`. Release It runs the release checks, prompts for the next version,
updates the selected package and lockfile, pushes the release, and creates the matching GitHub release. SDK and CLI
releases publish to npm and use `vX.Y.Z` and `cli-vX.Y.Z` tags. Stable Sandbox releases publish to Docker Hub and use
`sandbox-vX.Y.Z`. npm prompts for OTP or passkey approval when required. Stable image publication uses a temporary Docker
Hub browser login and a local Cosign installation. The active GitHub CLI account creates the source release. GitHub
Actions separately publishes GHCR `dev` after relevant changes reach `main`.

Release notes follow those package lanes instead of including every repository commit. CLI notes include commits scoped
to `cli`. SDK notes include commits scoped to `sdk` or an SDK-owned runtime, primitive, Agent, Sandbox, Workspace, or
provider area. Website, examples, root maintenance, and unscoped commits stay out of package release notes.

The release gate fetches and verifies the upstream branch before versioning. After the version and lockfile are bumped,
it runs the complete release checks again before npm publishing. Push and verify source commits first; the release flow
then owns only its version commit, package tag, npm publication, and GitHub release.

Preview the flow without changing Git, npm, or GitHub:

```sh
GITHUB_TOKEN="$(gh auth token)" npm run release:sdk -- --dry-run
GITHUB_TOKEN="$(gh auth token)" npm run release:cli -- --dry-run
npm run release:sandbox -- --dry-run
```

If registry publication fails after the release commit and `sandbox-vX.Y.Z` tag are created, rerun that exact release from a clean `main` checkout with `npm run release:sandbox -- --recover`.

The Astro website and Starlight documentation run locally at `http://localhost:5321/` from the repository root:

```sh
npm run dev
```

Run the command from the repository root. An `uv_cwd` or `process.cwd` `ENOENT` means the shell is still attached to a
directory that was moved or removed; open a new shell or `cd /path/to/agent-markup-language` before invoking npm.

The project site and documentation are one static Astro application:

```text
apps/website/src/
  pages/index.astro             marketing route composition
  layouts/MarketingLayout.astro
  components/marketing/        reusable homepage sections
  data/                        typed navigation, provider, and homepage content
  content/docs/                Starlight documentation source
  components/docs/             shared Starlight layout, provider, and page-action UI
  plugins/docs-markdown/        injected /[...path].md endpoint (per-page Markdown alternatives)
  pages/docs/llms.txt.ts        complete concatenated documentation
  styles/                      global Starlight layout and content rhythm
```

The public routes are intentionally available to both people and agents:

| Route                         | Purpose                                                         |
| ----------------------------- | --------------------------------------------------------------- |
| `/`                           | Marketing and project overview.                                 |
| `/docs/` and `/docs/**`       | Navigable Starlight documentation.                              |
| `/docs.md`                    | Markdown alternative for the documentation homepage.            |
| `/docs/<page>.md`             | Markdown alternative linked from every documentation page.      |
| `/llms.txt`                   | Concise project and editorial overview.                         |
| `/docs/llms.txt`              | Complete documentation in one text response.                    |
| `/robots.txt`, `/sitemap.xml` | Search crawler discovery; Markdown alternatives stay canonical. |

Marketing metadata is centralized in `src/config/site.ts`. Starlight extends its generated metadata through
`components/docs/DocHead.astro`, which adds the share image, Markdown alternate, complete-docs discovery link, and
structured data. Keep layout or typography changes in the shared layouts and global styles rather than individual
content pages.

Pushes to `main` deploy `apps/website/dist` to GitHub Pages at
[`agent-markup-language.com`](https://agent-markup-language.com/). The generated directory is ignored and uploaded directly
by GitHub Actions; it is not committed to a publishing branch.

## License

AML is available under the [MIT License](./LICENSE).
