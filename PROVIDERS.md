# Provider Wishlist

This document is the non-normative implementation queue for AML providers. [`SPEC.md`](./SPEC.md) defines provider behavior, while this file tracks integrations worth building and the architectural questions they can help answer.

Provider implementations live under private `providers/<kind>/<name>` workspaces and ship through `@aml-jsx/sdk` for now. A provider should be a thin adapter over the vendor's runtime: AML owns tree evaluation and lifecycle boundaries, while the provider owns its models, sessions, tools, permissions, filesystem behavior, and provider-specific options. Separate public packages can be reconsidered later if dependency weight or release cadence makes that boundary worthwhile.

## Recommended order

1. A remote Codex harness on Daytona, to prove an Agent process running beside its Workspace.
2. An OpenCode server on Daytona, to discover the smallest required long-running-process and port surface.
3. An S3-compatible Workspace, to prove remote durable materialization independently of a Sandbox vendor.
4. Vercel AI SDK, to prove that AML Agents do not require a coding CLI or built-in filesystem.
5. TanStack AI, to compare two provider-agnostic model SDKs against the same AML Agent contract.
6. One native volume Workspace paired with its Sandbox provider, to design the cross-provider mount contract deliberately.

## Agent providers

Agent providers fall into three useful categories:

- A coding harness owns a session and normally includes filesystem, search, editing, and shell capabilities.
- A model SDK owns model calls, message history, tool loops, and structured output but normally has no filesystem or shell of its own.
- A managed agent owns part or all of the session remotely and may also own memory, tools, or a sandbox.

Model SDKs are valid AML Agent providers. Their lack of file tools is not a contract failure: AML JavaScript Tools, MCP servers, and an active Sandbox supply those capabilities when the workflow needs them.

### Implemented

| Provider | Public export     | Kind           | Native coding tools |
| -------- | ----------------- | -------------- | ------------------- |
| OpenCode | `opencodeAgent()` | Coding harness | Yes                 |
| Codex    | `codexAgent()`    | Coding harness | Yes                 |
| Pi       | `piAgent()`       | Coding harness | Yes                 |

### Priority candidates

| Priority | Provider                                                                      | Proposed package             | Kind           | Why it is useful                                                                                                                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------- | ---------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | [Vercel AI SDK](https://ai-sdk.dev/)                                          | `@aml-jsx/agent-vercel-ai`   | Model SDK      | AI SDK 6 has a provider-agnostic model interface, agent/tool loops, custom tools, message input, stop conditions, and structured output. It would prove that AML can provide orchestration and filesystem capabilities around a lightweight model runtime. |
| P1       | [TanStack AI](https://tanstack.com/ai)                                        | `@aml-jsx/agent-tanstack-ai` | Model SDK      | TanStack AI provides provider adapters, typed tools, structured output, middleware, and composable loop strategies. Its adapter shape is a useful comparison against Vercel AI SDK.                                                                        |
| P1       | [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) | `@aml-jsx/agent-claude`      | Coding harness | Exposes Claude Code capabilities programmatically, including filesystem and shell tools, custom tools, permissions, sessions, and hooks.                                                                                                                   |
| P1       | [GitHub Copilot SDK](https://github.com/github/copilot-sdk)                   | `@aml-jsx/agent-copilot`     | Coding harness | Embeds the Copilot CLI agent runtime with planning, tool invocation, and file editing. It is currently a preview and should remain behind its own optional package.                                                                                        |
| P2       | [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/)               | `@aml-jsx/agent-openai`      | Agent SDK      | Provides tools, sessions, structured output, tracing, model providers, and optional sandbox agents. It overlaps with some AML orchestration, so the adapter should expose one Agent execution without importing SDK-level handoff semantics into AML.      |
| P2       | [Google ADK for TypeScript](https://github.com/google/adk-js)                 | `@aml-jsx/agent-google-adk`  | Agent SDK      | Adds a Google-oriented model, session, and tool runtime while testing how AML fits an SDK that already supports multi-agent composition.                                                                                                                   |
| P2       | [Letta](https://docs.letta.com/)                                              | `@aml-jsx/agent-letta`       | Managed agent  | Useful for persistent remote memory and long-lived agents. The AML adapter would treat the remote agent as one provider-owned session rather than adopting Letta's orchestration model.                                                                    |

### Research candidates

LangGraph, Mastra, Flue, and similar workflow frameworks overlap substantially with AML's orchestration layer. They are interoperability experiments rather than priority Agent providers. An adapter is worthwhile only if it can expose a single provider-owned Agent cleanly without making AML a second frontend for the framework's workflow graph.

Direct OpenAI, Anthropic, Google, Ollama, and OpenRouter model clients are lower priority while Vercel AI SDK and TanStack AI already provide broad model adapter ecosystems. A direct adapter becomes worthwhile when it exposes capabilities or configuration that those shared SDKs cannot preserve.

## Sandbox providers

### Implemented

| Provider | Public export      | Notes                                                                                               |
| -------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| Local    | `localSandbox()`   | Trusted host-process execution for development and common-runtime tests; not an isolation boundary. |
| Docker   | `dockerSandbox()`  | Starts a named image, mounts the Workspace, runs bounded commands, and never builds the image.      |
| Daytona  | `daytonaSandbox()` | Transfers and reconciles a Workspace around one disposable Daytona image or snapshot.               |

### Provider direction

Sandbox factories retain provider-native environment configuration. Applications select an image, snapshot, or provider environment containing the Agent and supporting tools. AML owns only acquisition, Workspace attachment, optional explicit setup, command execution, and release.

The common runtime deliberately begins with logical root/cwd/access metadata and bounded literal `exec()`. Provider-native files, ports, snapshots, and background processes remain outside the baseline until an Agent proof requires one.

An optional `setup` string is trusted application configuration executed inside the acquired environment before Agents run:

```ts
dockerSandbox({
  image: "node:26-alpine",
  setup: "npm install -g <agent-package>",
})
```

Repeated use should prefer a prebuilt image or snapshot. AML does not silently install Agents.

### Priority candidates

| Priority | Provider                                                             | Proposed package               | Why it is useful                                                                                                                                                                                      |
| -------- | -------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | [E2B](https://www.e2b.dev/docs)                                      | `@aml-jsx/sandbox-e2b`         | Focused agent sandbox API with fast Linux VMs, templates, commands, files, ports, and snapshots. Good minimal remote comparison.                                                                      |
| P1       | [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/) | `@aml-jsx/sandbox-cloudflare`  | Strong Worker-native execution boundary with Containers, files, commands, background processes, and service exposure. It also tests a non-Node host runtime and binding-based dependency injection.   |
| P1       | [Vercel Sandbox](https://vercel.com/docs/sandbox)                    | `@aml-jsx/sandbox-vercel`      | Firecracker microVMs, files, commands, ports, snapshots, and native Vercel authentication. Useful alongside the Vercel AI SDK Agent provider without coupling the two packages.                       |
| P1       | [Modal Sandboxes](https://modal.com/docs/sdk/js/latest/Sandbox)      | `@aml-jsx/sandbox-modal`       | TypeScript SDK, remote files and processes, tunnels, snapshots, network policy, and native distributed volumes.                                                                                       |
| P2       | [CodeSandbox SDK](https://codesandbox.io/sdk)                        | `@aml-jsx/sandbox-codesandbox` | Development-oriented microVMs with shells, forks, hibernation, snapshots, previews, and Git-backed persistence.                                                                                       |
| P2       | [Blaxel Sandboxes](https://docs.blaxel.ai/Sandboxes/Overview)        | `@aml-jsx/sandbox-blaxel`      | Fast remote microVMs, files, processes, previews, networking, volumes, and an MCP endpoint designed for coding agents.                                                                                |
| P3       | Kubernetes                                                           | `@aml-jsx/sandbox-kubernetes`  | Pods, namespaces, network policies, resource quotas, PVCs, and custom images. Valuable for self-hosted deployments but operationally much larger than the managed SDK adapters.                       |
| P3       | Firecracker                                                          | `@aml-jsx/sandbox-firecracker` | Direct microVM ownership and strong isolation for self-hosted installations. Requires image, networking, storage, and lifecycle infrastructure, so it should not precede managed-provider experience. |
| P3       | Fly Machines                                                         | `@aml-jsx/sandbox-fly`         | API-managed microVMs with volumes and networking. Worth considering when AML needs longer-lived regional machines rather than short agent sandboxes.                                                  |

## Workspace providers

A Workspace is not merely a storage client. It must materialize a filesystem for descendant Sandboxes, preserve changes after Sandbox release, and define concurrency and conflict behavior.

Workspace implementations fall into three categories:

- A synchronized Workspace copies files between durable storage and a materialized working directory.
- A native volume Workspace mounts storage directly into a compatible Sandbox provider.
- A source-control Workspace checks out a repository and applies an explicit save policy when evaluation ends.

### Implemented

| Provider        | Public export      | Kind                           |
| --------------- | ------------------ | ------------------------------ |
| Local directory | `localWorkspace()` | Direct durable materialization |

### Priority candidates

| Priority | Provider                     | Proposed package                | Kind           | Notes                                                                                                                                                                                                                                             |
| -------- | ---------------------------- | ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | S3-compatible object storage | `@aml-jsx/workspace-s3`         | Synchronized   | One configurable implementation should cover AWS S3, Cloudflare R2, Backblaze B2, Tigris, MinIO, DigitalOcean Spaces, and other compatible endpoints. Do not create separate R2 or B2 packages unless their semantics require different behavior. |
| P1       | Git                          | `@aml-jsx/workspace-git`        | Source control | Clone a repository and ref into a materialization. Saving must be explicit: return a patch, create a local commit, push a branch, or remain read-only. Automatic pushes must never be the implicit default.                                       |
| P1       | Google Cloud Storage         | `@aml-jsx/workspace-gcs`        | Synchronized   | Covers deployments that cannot or should not use an S3-compatible endpoint.                                                                                                                                                                       |
| P1       | Azure Blob Storage           | `@aml-jsx/workspace-azure-blob` | Synchronized   | Azure-native object storage with its own identity and concurrency model.                                                                                                                                                                          |
| P2       | SFTP/SSH                     | `@aml-jsx/workspace-sftp`       | Synchronized   | Useful for existing servers and appliances where object storage is unavailable. Requires careful atomic-save and conflict semantics.                                                                                                              |
| P2       | Network filesystem           | `@aml-jsx/workspace-nfs`        | Mounted        | NFS, EFS, Azure Files, and similar filesystems can expose a shared tree, but mounting depends on Sandbox networking and privileges.                                                                                                               |

### Native volume candidates

| Sandbox ecosystem | Proposed package                    | Storage                           |
| ----------------- | ----------------------------------- | --------------------------------- |
| Docker            | `@aml-jsx/workspace-docker-volume`  | Named Docker volume               |
| Daytona           | `@aml-jsx/workspace-daytona-volume` | Daytona shared volume and subpath |
| Modal             | `@aml-jsx/workspace-modal-volume`   | Modal Volume                      |
| Blaxel            | `@aml-jsx/workspace-blaxel-volume`  | Blaxel Volume                     |
| Kubernetes        | `@aml-jsx/workspace-kubernetes-pvc` | PersistentVolumeClaim             |

Native volumes require coordination between the Workspace and Sandbox providers. The Workspace should produce an opaque mount descriptor, and only a compatible Sandbox provider should interpret it. The SDK should reject incompatible combinations before starting Agents. This contract should be designed and added to the SPEC before implementing the first native volume provider.

### Block storage

Raw block devices such as EBS, GCE Persistent Disk, and Azure Managed Disk are not good standalone AML Workspace providers. Attaching and mounting them is coupled to the compute provider, region, operating system, filesystem, and exclusive-writer rules. Represent them through a compatible Sandbox-native volume provider rather than pretending they are portable storage.

For shared repository trees, object storage synchronization, provider-native volumes, network filesystems, and Git are better fits. Databases that genuinely require block storage should normally run as external services or inside infrastructure designed for them, not inside a disposable agent Workspace.

## Acceptance checklist

Every new provider should include:

- A configured factory with provider-native options and no hidden global construction.
- The relevant SDK conformance suite.
- Deterministic tests for lifecycle, cancellation, errors, and capability mapping.
- An opt-in live integration test against the real provider.
- One self-contained example that imports the built package through its public export.
- Trace events that expose provider lifecycle without leaking credentials or full prompt content by default.
- Documentation of unsupported AML capabilities and whether the provider supplies native filesystem, shell, sessions, MCP, structured output, snapshots, or durable storage.
