# Sandboxing architecture notebook

Status: non-normative architecture notes

This document records the architecture and current direction for connecting AML Agents, Sandboxes, and Workspaces. It is intentionally separate from [`SPEC.md`](./SPEC.md). Decisions become normative only after they are moved into the specification and implemented.

## Current direction

The current design deliberately avoids turning AML into a generic filesystem, process, image-build, or container-security layer:

- AML coordinates Sandboxes; it does not provision their software.
- AML supplies a tested default Agent image for Docker, Daytona, and Modal; applications may select another provider-native image, snapshot, package set, or host environment.
- An explicit `setup` hook may install missing software after acquisition as a convenience, but hidden installation is forbidden.
- `SandboxRuntime.spawn()` is the process transport beneath the shared ACP session engine. `exec()` remains for bounded Scripts, setup, and provider internals; it is not an alternative Agent protocol.
- Every built-in coding Agent uses the same ACP lifecycle on the trusted local host and inside every supported Sandbox.
- Workspace attachment and reconciliation are lifecycle responsibilities, not a model-facing generic filesystem.

## Goal

AML needs to support any compatible Agent with any compatible Sandbox without implementing every Agent × Sandbox combination.

```text
Agent profile                 shared ACP engine               process launcher
Pi ───────────────┐       ┌─ initialize/session ─┐       ┌── trusted local host
Codex ────────────┼───────┤  prompts/updates     ├───────┼── Docker
OpenCode ─────────┘       └─ cancel/cleanup ─────┘       ├── Daytona
                                                        └── Modal
                                                               │
                                                       attached Workspace
```

This creates two linear integration surfaces:

- each Agent profile declares how to launch and configure its ACP Agent
- the shared engine implements the protocol lifecycle once
- each Sandbox provider implements the small process runtime and Workspace lifecycle

Provider factories remain provider-specific. Applications construct `dockerSandbox(...)`, `daytonaSandbox(...)`, or `modalSandbox(...)` with the configuration concepts supported by that provider. Environment identity uses a consistent root option where the providers overlap: `image` for Docker, Daytona, and Modal, or Daytona's alternative `snapshot`. AML should not expose a generic `sandboxSdk({ adapter })` factory or force the remaining provider configuration into one lowest-common-denominator object.

## Responsibility contract

### Application and environment author

The application accepts AML's default image or selects another execution environment:

- Docker image
- Daytona snapshot or image
- Modal registry image
- Cloudflare container configuration
- another provider-native environment reference

That environment is responsible for containing its operating-system dependencies, language runtimes, ACP Agent executables, and supporting tools. The environment author owns their versions and update policy.

For example, choosing Codex for a Modal Sandbox requires an image that already contains the compatible Codex ACP adapter and runtime. AML's default image satisfies that executable contract; an override must do the same. AML does not inspect an arbitrary image and install Codex automatically.

AML publishes `aml-agent-sandbox` as a separate, versioned distribution artifact containing the supported Agents and useful coding tools. Docker Hub is the canonical stable registry, and provider factories select its `latest` tag by default. GHCR carries the public, mutable `dev` nightly/edge channel used by repository validation; it is not a stable mirror. Image construction, project dependencies, credentials, and deployment hardening remain outside the Sandbox runtime.

### AML coordinator

The AML coordinator remains local and owns sequencing:

1. acquire the Workspace materialization
2. acquire the configured Sandbox and attach or hydrate the Workspace
3. run the explicit Sandbox `setup` hook, if configured
4. ask the shared ACP engine to launch the selected Agent profile in the Sandbox
5. reconcile writable Workspace changes
6. release the Sandbox and Workspace

“The Agent runs in the Sandbox” means the ACP Agent process and its native operations run beside the Workspace. The AML component tree, ACP client, JavaScript Tool execution, and orchestration remain in the AML host.

### Sandbox provider

A Sandbox provider owns:

- creating or connecting to one environment selected by the application
- attaching or hydrating the Workspace at a stable guest location
- executing a command with a working directory, environment, cancellation, and a bounded result
- spawning a long-lived process with queued output, writable input, repeatable completion, and process-tree termination
- releasing the environment
- reconciling the Workspace when its provider cannot use a shared mount
- mapping explicitly supported provider options such as resources, secrets, or network policy

A Sandbox provider does not own:

- building Docker images
- translating Dockerfiles
- installing Agents or development tools by default
- choosing Agent versions
- maintaining an Agent × Sandbox compatibility matrix
- emulating every filesystem or process API exposed by another Sandbox SDK

The Docker provider should go no further than starting a named image, attaching the Workspace, running commands in the container, and stopping it. It should not become an image builder or general container platform.

Docker is useful local process and filesystem isolation, but a lightweight `docker run` adapter must not be marketed as a complete hostile-code security boundary.

### Agent adapter

The shared ACP engine owns:

- process launch through the current local or Sandbox launcher
- ACP initialization, capability negotiation, and session creation
- sequential initial and FollowUp prompts
- streaming updates, cancellation, and final result collection
- common MCP bridges for JavaScript Tools and structured output
- closing streams, bridges, and the complete process tree on every exit path

An Agent profile owns:

- the already-installed ACP command and arguments
- provider configuration, environment, and credentials
- model and system-instruction mappings not standardized by ACP
- native permission mappings and enforcement limits
- clear failure when the selected environment lacks its executable or negotiated capability

Profiles do not own alternative SDK, CLI, embedded, or server session loops. Staging small AML-owned configuration is different from installing the Agent: the environment contains packages and binaries; the profile supplies only invocation glue.

### Workspace provider

A Workspace owns the durable logical working tree, writer coordination, and persistence. It does not decide where commands execute.

The Sandbox provider owns the attachment mechanism because it varies:

- Docker can bind-mount a same-host directory.
- Daytona can transfer files or attach a native volume.
- another provider may use an archive, object-store synchronization, or a provider-native mount.

The observable contract is one working tree at the Agent’s guest working directory. Docker currently uses `/workspace`; Daytona uses `workspace` under its default writable working directory because its standard user cannot write filesystem root. AML does not require every Sandbox to expose the same absolute path or low-level transfer implementation.

## Explicit setup hook

An optional setup hook is useful for experiments, smoke tests, and environments where creating a custom image is unnecessary overhead:

```ts
modalSandbox({
  config: {
    // Modal-native configuration
  },
  setup: "npm install -g <agent-package>",
})
```

`setup` is a better working name than `postinstall`:

- it runs after Sandbox acquisition, not after a package-manager install
- it may install packages, write configuration, or perform another preparation step
- it applies equally to Docker, Daytona, Modal, Cloudflare, and future providers

Proposed semantics:

- The hook is trusted application configuration, never model-generated text.
- It runs after the Sandbox is ready and the Workspace is visible, but before the Agent starts.
- A string is executed by the provider’s documented/default shell; AML must not assume Bash exists.
- It runs on every Sandbox acquisition and is not implicitly cached.
- A non-zero exit fails acquisition before the Agent starts.
- Output is surfaced as setup output, with configured secrets redacted from AML traces.
- The hook receives only the environment and secrets explicitly configured for it.
- Any Workspace changes made by setup follow the Workspace’s normal access and persistence policy.

Repeated or production use should prefer a prebuilt image or snapshot. Modal explicitly recommends building and publishing named images separately from Sandbox creation. Daytona snapshots and Cloudflare custom images serve the same reproducibility purpose.

AML should not attempt to translate `setup` into every provider’s native image-build or boot-hook feature. The adapter runs it as a bounded command before the ACP process starts. Provider-native startup configuration may still be passed through the provider’s own `config`.

The exact public type remains open. Start with one command string and add multiple or structured commands only when a real use case requires them.

## ACP harness reference

ACP defines a standard JSON-RPC session between a client and a coding Agent. AML connects its client to the Agent's
standard input and output through the current process launcher:

1. AML acquires the Sandbox and materializes the Workspace.
2. The shared engine spawns the selected profile's ACP Agent at the guest working directory.
3. AML initializes ACP and creates one session with the invocation's MCP servers.
4. AML sends the initial prompt and FollowUps while consuming streamed updates.
5. AML requests cancellation when supported and terminates the invocation-owned process tree during cleanup.
6. Sandbox release reconciles the Workspace and reclaims any remaining lease-owned processes.

Credentials follow the ACP Agent that needs them. They are injected deliberately through provider-native secrets or
process environment configuration, redacted from traces, and never persisted as Workspace files.

## Workspace attachment lifecycle

A child Sandbox does not acquire the Workspace independently. AML owns the order:

1. `<Workspace>` acquires one materialization.
2. AML passes a reference to the Sandbox provider.
3. The Sandbox provider attaches or hydrates it at a stable provider-owned guest root.
4. AML runs the optional setup hook.
5. The Agent adapter starts the Agent with its working directory inside that guest root.
6. On writable release, the Sandbox provider reconciles guest changes, including deletions.
7. `<Workspace>` saves and releases its materialization.

For the first remote implementation, full synchronization is sufficient:

- upload the selected tree before descendants run
- place it at the provider's stable guest root
- mirror additions, modifications, and deletions back before release

Continuous synchronization and crash-safe incremental persistence are later features. A provider failure before reconciliation may lose unsynchronized remote edits and must be reported honestly.

## Paths and working directories

Keep these concepts distinct:

- the Workspace provider’s host materialization directory
- AML’s logical Sandbox root
- AML’s logical Agent working directory
- the Sandbox provider’s guest filesystem paths

The host path is transfer or mount input. It must never become the Agent’s working directory.

```text
AML root:         .
AML Agent cwd:    packages/api
guest root:       /workspace
guest Agent cwd:  /workspace/packages/api
```

The Sandbox provider must enforce Workspace access through its mount, transfer, credential, or provider-native policy. Agent adapters should receive the final guest working directory and should not each reimplement path confinement.

## Narrow `SandboxRuntime`

A broader runtime could include stream-first file access, path resolution, process helpers, capability metadata, and provider-specific emulation. That surface would move too much Sandbox-provider behavior into AML before Agent requirements justify it.

The common runtime exposes the smallest process boundary required to start an Agent:

- one stable logical working directory
- literal executable and argument values
- optional working-directory and environment overrides
- cancellation and timeout support
- a bounded exit result containing standard output and error
- a streaming process handle for interactive and server-based Agent harnesses

Commands do not implicitly pass through a shell. The explicit `setup` convenience is the only common string interpreted through a provider-selected shell.

`spawn()` is the long-running counterpart to `exec()`. It returns a portable process identity, standard Web streams for input and queued output, repeatable completion, and idempotent process-tree termination. Output capture starts before the handle is returned. Closing the writable stream requests stdin EOF when the provider supports it; providers without a remote half-close still close AML's writable side. Process ownership is scoped to one Sandbox lease, and releasing that lease reclaims its remaining processes or disposable environment.

Do not add features until an Agent requirement demands them:

- Authenticated port exposure may be needed to connect a local SDK to an Agent server.
- Provider-native file transfer is needed internally for remote Workspace hydration, but it does not need to be Agent-facing runtime CRUD.
- Snapshots, forks, and warm starts are control-plane features outside the Agent runtime.
- A provider-native handle may remain an internal escape hatch for Workspace attachment and provider-specific optimizations.

The API should grow from Agent requirements, not from the union of Daytona, Modal, Cloudflare, Docker, or Sandbox SDK feature lists.

## ACP Agent profiles

Codex, OpenCode, and Pi are configuration profiles over one engine:

- Codex launches the maintained Codex ACP adapter.
- OpenCode launches its native ACP Agent.
- Pi launches the maintained Pi ACP adapter.

Each selected environment must contain the compatible executable. The engine passes the effective Workspace cwd,
explicit MCP servers, and AML-owned bridges during ACP session creation; named native servers remain profile
configuration. The engine reuses that session for FollowUps, consumes streaming updates, and owns process cleanup.

ACP intentionally does not erase Agent differences. A profile may map AML's model and system channel through
Agent-specific configuration, reject an unsupported MCP transport, or report that an exact native permission is not
enforceable. Those are profile capability differences, not reasons to fork the session lifecycle.

JavaScript Tools use one AML-owned MCP bridge. Structured output uses one AML-owned MCP submission Tool on the final
turn. Native Agent operations remain inside the Agent process; the outer Sandbox is their security boundary. ACP
permission requests are workflow interactions and must not be represented as filesystem or process confinement.

## Third-party Sandbox abstractions

[Sandbox SDK](https://sandbox-sdk.sh/) is a useful design reference:

- it models files, processes, ports, snapshots, normalized errors, conformance, and provider escape hatches as explicit capabilities
- it keeps provider construction options on individual adapters rather than flattening every provider into one configuration object

AML should learn from those provider boundaries without copying the complete feature surface or taking a dependency before the external contracts are stable and useful to AML.

## Security boundaries

- Sandbox setup is trusted application configuration. Model-generated commands belong to the Agent running inside the Sandbox.
- The Sandbox runtime is trusted adapter infrastructure; it is not automatically a set of model-callable tools.
- Missing Agent binaries or runtimes fail clearly. AML never falls back to host execution.
- ACP permission requests do not replace Sandbox access, process, mount, or network enforcement.
- Environment variables and secrets are scoped to setup or Agent processes where possible, excluded from traces, and excluded from Workspace persistence.
- Read-only Workspace policy must be enforced by the provider’s attachment or synchronization mechanism, including setup commands.
- Exposed ports may contain bearer URLs, tokens, or required headers and must be treated as credentials.
- Agent termination, Workspace reconciliation, Sandbox release, and Workspace release need failure-safe ordering.

## Smoke matrix

The credentialed smoke matrix exercises the Cartesian product of supported Agent and Sandbox providers. It is separate from default unit tests because it may require credentials, containers, network access, remote infrastructure, and real model calls.

Each Agent has one canonical registration. Docker, Daytona, and Modal matrix cells use the same public `ghcr.io/we-are-singular/aml-agent-sandbox:dev` image; Local uses the matching host-installed executables. Adding either axis therefore requires an explicit compatibility decision for the other axis rather than silently skipping unknown combinations.

Every selected cell runs the same end-to-end behavior:

1. acquire a durable Workspace
2. acquire the selected Sandbox and attach or hydrate that Workspace
3. launch the selected Agent profile through the shared ACP engine and Sandbox `spawn()`
4. have the Agent read an unpredictable input and write an exact output
5. release the Sandbox and reconcile changes
6. verify the output from the durable Workspace

The matrix emits the normal AML trace tree plus clear cell start and failure context. A failed compatibility handshake is a valid, visible result; the smoke layer must not replace production adapters with permissive test wrappers.

Provider-specific environment preparation belongs to matrix configuration, while Agent configuration continues to use the same provider factories applications use. Credentials are injected only into the environment that needs them and must never be copied into the Workspace.

The matrix supports selecting one Agent, one Sandbox, either complete axis, or the full Cartesian product. Documentation should describe the covered combinations and shared guarantee without copying timestamps, durations, output sizes, or individual run results into this architecture notebook. Current results belong in test output and CI artifacts.

## Future considerations

These are possible extensions, not implementation phases:

- evaluate narrower or multi-architecture image variants only after provider evidence justifies their additional release cost
- add Sandbox providers only when they preserve provider-native environment configuration
- evaluate snapshots, warm starts, retries, and forks as control-plane capabilities
- add authenticated service access only when an Agent requires it
- revisit third-party Sandbox abstraction libraries when their packages and contracts are stable

## References

- [Daytona: Build a Coding Agent Using Codex SDK and Daytona](https://www.daytona.io/docs/en/guides/codex/codex-sdk-interactive-terminal-sandbox/)
- [Daytona snapshots](https://www.daytona.io/docs/en/snapshots/)
- [Modal Sandboxes](https://modal.com/docs/guide/sandboxes)
- [Cloudflare Sandbox custom images](https://github.com/cloudflare/sandbox-sdk/blob/main/docs/STANDALONE_BINARY.md)
- [Sandbox SDK](https://sandbox-sdk.sh/)
- [Agent Client Protocol architecture](https://agentclientprotocol.com/get-started/architecture)
- [Agent Client Protocol session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [ACP Agents](https://agentclientprotocol.com/get-started/agents)
