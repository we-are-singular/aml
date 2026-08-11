# Provider Wishlist

This document is the non-normative implementation queue for AML providers. [`SPEC.md`](./SPEC.md) defines provider behavior, while this file tracks integrations worth building and the architectural questions they can help answer.

Provider implementations live under private `providers/<kind>/<name>` workspaces and ship through `@aml-jsx/sdk` for now. Built-in coding agents are thin profiles over AML's shared ACP session engine. Profiles own executable selection and provider-specific configuration; they do not own parallel session, Tool, output, or cleanup implementations. Separate public packages can be reconsidered later if dependency weight or release cadence makes that boundary worthwhile.

## Recommended order

1. Prove the full Codex, GitHub Copilot, OpenCode, and Pi matrix through the currently supported Sandbox `spawn()` implementations.
2. Revisit AgentOS only when it can join that same ACP process boundary.
3. Add further coding agents only through compatible ACP implementations.
4. Design volume-mounted Workspaces with compatible Sandbox providers deliberately.

## Agent providers

Agent providers fall into two useful categories:

- A built-in coding Agent exposes ACP and normally includes filesystem, search, editing, and shell capabilities.
- A custom structural provider implements `AgentProvider` for deterministic tests or application-specific behavior without claiming built-in coding-agent or Sandbox portability.

Model SDKs remain possible custom providers, but they are not a second built-in integration strategy. A future built-in coding Agent must have a compatible ACP implementation.

### Implemented

| Provider       | Public export     | Kind           | Native coding tools |
| -------------- | ----------------- | -------------- | ------------------- |
| OpenCode       | `opencodeAgent()` | Coding harness | Yes                 |
| Codex          | `codexAgent()`    | Coding harness | Yes                 |
| GitHub Copilot | `copilotAgent()`  | Coding harness | Yes                 |
| Pi             | `piAgent()`       | Coding harness | Yes                 |

These public factories are thin ACP profiles over the shared session engine.

### Priority candidates

| Priority | Provider                                                                                                 | Proposed package        | Why it is useful                                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| P0       | [Hermes](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/acp.md) | `@aml-jsx/agent-hermes` | Native stdio ACP mode with sessions, tools, diffs, terminal operations, approvals, and streamed content.              |
| P0       | [Amp](https://agentclientprotocol.com/get-started/registry)                                              | `@aml-jsx/agent-amp`    | Registry-distributed ACP wrapper for Amp and a useful proof for another opinionated coding harness.                   |
| P1       | [Claude Agent](https://agentclientprotocol.com/get-started/registry)                                     | `@aml-jsx/agent-claude` | Maintained ACP wrapper for Claude Code; important parity for a major coding agent.                                    |
| P1       | [Cursor](https://agentclientprotocol.com/get-started/registry)                                           | `@aml-jsx/agent-cursor` | Registry-distributed Cursor Agent; tests a vendor-owned ACP implementation rather than an AML-maintained integration. |
| P1       | [Gemini CLI](https://agentclientprotocol.com/get-started/registry)                                       | `@aml-jsx/agent-gemini` | Native ACP support from another major coding-agent family.                                                            |

### Research candidates

LangGraph, Mastra, Flue, Vercel AI SDK, TanStack AI, and similar model or workflow frameworks overlap with AML's
Agent loop or orchestration layer. They are application-specific structural-provider experiments rather than
priority built-ins. An integration is worthwhile only when a concrete application needs it and it does not create a
second coding-agent lifecycle.

## Sandbox providers

### Implemented

| Provider | Public export      | Notes                                                                                               |
| -------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| Local    | `localSandbox()`   | Trusted host-process execution for development and common-runtime tests; not an isolation boundary. |
| Docker   | `dockerSandbox()`  | Starts a named image, mounts the Workspace, runs bounded commands, and never builds the image.      |
| Daytona  | `daytonaSandbox()` | Transfers and reconciles a Workspace around one disposable Daytona image or snapshot.               |
| Modal    | `modalSandbox()`   | Transfers and reconciles a Workspace around one disposable Modal registry image.                    |

### Provider direction

Sandbox factories retain provider-native environment configuration. Applications select an image, snapshot, package set, or provider environment containing the ACP Agents and supporting tools. AML owns acquisition, Workspace attachment, optional explicit setup, command execution, safe process spawning, and release.

The common runtime exposes bounded literal `exec()` plus a streaming `spawn()` handle with queued output, input, repeatable completion, and process-tree termination. Provider-native files, ports, and snapshots remain outside the baseline until a concrete requirement proves them.

An optional `setup` string is trusted application configuration executed inside the acquired environment before Agents run:

```ts
dockerSandbox({
  image: "node:26-alpine",
  setup: "npm install -g <agent-package>",
})
```

Repeated use should prefer a prebuilt image or snapshot. AML does not silently install Agents.

### Priority candidates

AgentOS remains a high-priority candidate because its mounted virtual machines start quickly and its prototype proved Workspace mounting, read-only policy, command execution, persisted guest writes, and the required queued process semantics. It is intentionally not part of the current implementation: its Codex software package owns the ACP client behind a package-private entrypoint instead of exposing a spawnable raw ACP process. AML will revisit it when all supported Agents can use the same `SandboxRuntime.spawn()` lifecycle rather than adding an AgentOS-specific session path.

| Priority | Provider                                                             | Proposed package               | Why it is useful                                                                                                                                                                                      |
| -------- | -------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | [E2B](https://www.e2b.dev/docs)                                      | `@aml-jsx/sandbox-e2b`         | Focused agent sandbox API with fast Linux VMs, templates, commands, files, ports, and snapshots. Good minimal remote comparison.                                                                      |
| P0       | [AgentOS](https://agentos-sdk.dev/docs/)                             | `@aml-jsx/sandbox-agentos`     | Very fast mounted VMs and an Agent software registry; blocked until its packages expose provider-neutral raw ACP process entrypoints.                                                                 |
| P1       | [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/) | `@aml-jsx/sandbox-cloudflare`  | Strong Worker-native execution boundary with Containers, files, commands, background processes, and service exposure. It also tests a non-Node host runtime and binding-based dependency injection.   |
| P1       | [Vercel Sandbox](https://vercel.com/docs/sandbox)                    | `@aml-jsx/sandbox-vercel`      | Firecracker microVMs, files, commands, ports, snapshots, and native Vercel authentication. Useful alongside the Vercel AI SDK Agent provider without coupling the two packages.                       |
| P2       | [CodeSandbox SDK](https://codesandbox.io/sdk)                        | `@aml-jsx/sandbox-codesandbox` | Development-oriented microVMs with shells, forks, hibernation, snapshots, previews, and Git-backed persistence.                                                                                       |
| P2       | [Blaxel Sandboxes](https://docs.blaxel.ai/Sandboxes/Overview)        | `@aml-jsx/sandbox-blaxel`      | Fast remote microVMs, files, processes, previews, networking, volumes, and an MCP endpoint designed for coding agents.                                                                                |
| P3       | Firecracker                                                          | `@aml-jsx/sandbox-firecracker` | Direct microVM ownership and strong isolation for self-hosted installations. Requires image, networking, storage, and lifecycle infrastructure, so it should not precede managed-provider experience. |
| P3       | Fly Machines                                                         | `@aml-jsx/sandbox-fly`         | API-managed microVMs with volumes and networking. Worth considering when AML needs longer-lived regional machines rather than short agent sandboxes.                                                  |

## Workspace providers

A Workspace is not merely a storage client. It must materialize a filesystem for descendant Sandboxes, preserve changes after Sandbox release, and define concurrency and conflict behavior.

Workspace evaluation locks and writable-Sandbox scheduling are separate. `lock` defaults to enabled and protects one
durable identity across evaluations. `writeConcurrency` defaults to `"serial"` and queues writable root Sandboxes
inside that evaluation from acquisition through reconciliation; read-only Sandboxes and Agents sharing one Sandbox
remain parallel. Explicit `"parallel"` writes are safe for shared mounts but may race for transferred snapshots.

Workspace implementations fall into three categories:

- A synchronized Workspace copies files between durable storage and a materialized working directory.
- A native volume Workspace mounts storage directly into a compatible Sandbox provider.
- A source-control Workspace checks out a repository and applies an explicit save policy when evaluation ends.

### Implemented

| Provider                     | Public export           | Kind                                     |
| ---------------------------- | ----------------------- | ---------------------------------------- |
| Local directory              | `localWorkspace()`      | Direct durable materialization           |
| Local revision store         | `filesystemWorkspace()` | Synchronized archive or folder revisions |
| S3-compatible object storage | `s3Workspace()`         | Synchronized archive or folder revisions |

`s3Workspace()` is the public adapter for stores that implement the conditional S3 object operations its lock and
revision protocol requires. It uses a fixed five-minute lock heartbeat and a twenty-minute stale boundary when locking
is enabled. Endpoint, region, credentials, path-style addressing, and injected clients are configuration; they do not
justify `minioWorkspace()`, `b2Workspace()`, or similar aliases. “S3-compatible” alone does not prove the required
conditional operations, so each service must be tested before support is claimed. Add a vendor-specific Workspace only
when the vendor needs a different transport, authentication boundary, or persistence/concurrency behavior. Such an
adapter may reuse public `WorkspacePersistence` through a narrow `WorkspaceStorageAdapter`, but it must expose and test
its own locking and transport guarantees.

### Priority candidates

| Priority | Provider       | Kind         | Notes                                                                                                                                              |
| -------- | -------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Volume mounts  | Mounted      | Expose provider-native volume mount options through compatible Sandbox providers instead of inventing a Docker-specific Workspace abstraction.     |
| P1       | Network mounts | Mounted      | Support shared filesystems such as SMB and NFS when the Sandbox network and privilege model can mount them safely.                                 |
| P2       | SFTP           | Synchronized | Reuse shared persistence where possible while defining atomic publication and conflict behavior over an existing server.                           |
| P2       | Google Drive   | Synchronized | Map Drive folders and files into a materialized Workspace while handling its non-filesystem identity, revision, and rename semantics deliberately. |

Volume mounts require coordination between the Workspace and Sandbox providers. The Workspace should produce an
opaque mount descriptor, and only a compatible Sandbox provider should interpret it. The SDK should reject
incompatible combinations before starting Agents. This contract should be designed and added to the SPEC before
implementing the first volume-mounted Workspace.

### Block storage

Raw block devices such as EBS, GCE Persistent Disk, and Azure Managed Disk are not good standalone AML Workspace providers. Attaching and mounting them is coupled to the compute provider, region, operating system, filesystem, and exclusive-writer rules. Represent them through a compatible Sandbox-native volume provider rather than pretending they are portable storage.

For shared repository trees, object storage synchronization, volume mounts, and network filesystems are better fits.
Databases that genuinely require block storage should normally run as external services or inside infrastructure
designed for them, not inside a disposable agent Workspace.

## Acceptance checklist

Every new provider should include:

- A configured factory with provider-native options and no hidden global construction.
- Either the matching optional abstract lifecycle template or a deliberate structural implementation of the same public interface.
- The relevant SDK conformance suite.
- Deterministic tests for lifecycle, cancellation, errors, and capability mapping.
- An opt-in live integration test against the real provider.
- One self-contained example that imports the built package through its public export.
- Trace events that expose provider lifecycle without leaking credentials or full prompt content by default.
- Documentation of unsupported AML capabilities and whether the provider supplies native filesystem, shell, sessions, MCP, structured output, snapshots, or durable storage.
