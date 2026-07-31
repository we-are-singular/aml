# Sandboxing architecture notebook

Status: non-normative architecture notes

This document records the architecture and current direction for connecting AML Agents, Sandboxes, and Workspaces. It is intentionally separate from [`SPEC.md`](./SPEC.md). Decisions become normative only after they are moved into the specification and implemented.

## Current direction

The current design deliberately avoids turning AML into a generic filesystem, process, image-build, or container-security layer:

- AML coordinates Sandboxes; it does not provision their software.
- Applications select a provider-native image, snapshot, or environment that already contains the required Agent and tools.
- An explicit `setup` hook may install missing software after acquisition as a convenience, but hidden installation is forbidden.
- The common runtime starts with bounded process execution and a working directory. That contract is sufficient for Pi's shell bridge and for the implemented Codex and OpenCode CLI harnesses. File transfer, image building, snapshots, ports, and other provider features are not part of the baseline merely because one provider exposes them.
- Workspace attachment and reconciliation are lifecycle responsibilities, not a model-facing generic filesystem.

## Goal

AML needs to support any compatible Agent with any compatible Sandbox without implementing every Agent × Sandbox combination.

```text
Agent adapter                    Sandbox provider
Pi ───────────────┐          ┌── Docker
Codex ────────────┼─ Sandbox ├── Daytona
OpenCode ─────────┘  Runtime └── Modal, Cloudflare, ...
                         │
                 attached Workspace
```

This creates two linear integration surfaces:

- each Agent adapter learns how to start its Agent through the AML runtime
- each Sandbox provider implements the small AML runtime and Workspace lifecycle

Provider factories remain provider-specific. Applications construct `dockerSandbox(...)`, `daytonaSandbox(...)`, or `modalSandbox(...)` with the configuration concepts supported by that provider. Environment identity uses a consistent root option where the providers overlap: `image` for Docker, Daytona, and Modal, or Daytona's alternative `snapshot`. AML should not expose a generic `sandboxSdk({ adapter })` factory or force the remaining provider configuration into one lowest-common-denominator object.

## Responsibility contract

### Application and environment author

The application selects the execution environment:

- Docker image
- Daytona snapshot or image
- Modal named image
- Cloudflare container configuration
- another provider-native environment reference

That environment is responsible for containing its operating-system dependencies, language runtimes, Agent SDKs or CLIs, and supporting tools. The environment author owns their versions and update policy.

For example, choosing Codex for a Modal Sandbox means selecting a Modal image that already contains the required Codex package and Node.js runtime. AML does not detect that choice and install Codex automatically.

AML may later publish a convenient, versioned image containing supported Agents and useful coding tools. That would be a separate distribution artifact, not a responsibility of the Sandbox runtime.

### AML coordinator

The AML coordinator remains local and owns sequencing:

1. acquire the Workspace materialization
2. acquire the configured Sandbox and attach or hydrate the Workspace
3. run the explicit Sandbox `setup` hook, if configured
4. ask the Agent adapter to start its Agent in the Sandbox
5. reconcile writable Workspace changes
6. release the Sandbox and Workspace

“The Agent runs in the Sandbox” describes the Agent provider process, server, CLI, or SDK harness. The AML component tree and orchestration still run locally.

### Sandbox provider

A Sandbox provider owns:

- creating or connecting to one environment selected by the application
- attaching or hydrating the Workspace at a stable guest location
- executing a command with a working directory, environment, cancellation, and a bounded result
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

An Agent adapter owns:

- knowing how its already-installed Agent is started
- staging only small AML-owned configuration or harness files when required
- passing provider configuration and credentials to the Agent process
- translating Agent events and results into AML
- failing clearly when the selected environment does not contain its required runtime or executable

Staging a small AML harness is different from installing the Agent. The image contains packages and binaries; the adapter supplies the glue needed to run them as an AML Agent.

The default strategy is a remote harness: start the actual Agent beside its Workspace in the Sandbox and let its native tools operate on that filesystem. Codex and OpenCode now do this through their installed non-interactive CLIs. A native-tool bridge such as Pi's remains possible, but is an Agent-specific optimization rather than the reason to give every Sandbox a complete generic filesystem API.

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

AML should not attempt to translate `setup` into every provider’s native image-build or boot-hook feature. Once the environment is ready, the adapter runs it through the same minimal execution primitive used to start an Agent. Provider-native startup configuration may still be passed through the provider’s own `config`.

The exact public type remains open. Start with one command string and add multiple or structured commands only when a real use case requires them.

## Remote harness reference

Daytona’s [Codex SDK guide](https://www.daytona.io/docs/en/guides/codex/codex-sdk-interactive-terminal-sandbox/) uses a remote harness:

1. a local Node.js program creates and manages the Daytona Sandbox
2. it passes the OpenAI API key into the Sandbox environment
3. it writes Daytona-specific Codex instructions
4. it uploads a small Node.js Agent package and installs its dependencies
5. it starts that package as an asynchronous Daytona process and streams its output
6. the remote package uses the Codex SDK with a working directory inside Daytona

The important architecture is that Codex and its CLI subprocess run inside Daytona. Daytona is the outer isolation boundary; Codex is not translating individual file and shell operations into Daytona API calls.

Installing dependencies during the tutorial is a valid convenience, not AML’s production default. In AML it maps to an explicit `setup` hook. A reusable deployment should put those dependencies in the selected snapshot or image.

The guide passes the model API key into the remote environment, where model-controlled code may read it. Credentials must follow the harness that needs them, be injected deliberately through provider-native secrets or process environment configuration, be redacted from traces, and never be persisted as Workspace files.

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

Commands do not implicitly pass through a shell. The explicit `setup` convenience is the only common string interpreted through a provider-selected shell.

Do not add features until an Agent requirement demands them:

- Long-running `spawn`, streaming output, and termination may be needed by interactive or server-based Agent harnesses, but the current Pi, Codex, and OpenCode integrations do not require them.
- Authenticated port exposure may be needed to connect a local SDK to an Agent server.
- Provider-native file transfer is needed internally for remote Workspace hydration, but it does not need to be Agent-facing runtime CRUD.
- Snapshots, forks, and warm starts are control-plane features outside the Agent runtime.
- A provider-native handle may remain an internal escape hatch for Workspace attachment and provider-specific optimizations.

The API should grow from Agent requirements, not from the union of Daytona, Modal, Cloudflare, Docker, or Sandbox SDK feature lists.

## Agent adapter strategies

### Pi

The Pi integration replaces only Pi’s native `bash` operation with the common `exec()` runtime. The model can still read, write, inspect, and run files through shell programs without forcing generic filesystem CRUD into every Sandbox.

This native-tool bridge deliberately keeps Pi itself in the local AML process, so its Sandbox needs only a compatible shell. Remote-harness Agents such as Codex and OpenCode remain responsible for selecting images that contain those Agents. Keep the Pi bridge only while it remains materially useful beside the remote-harness strategy.

### Codex

The Codex SDK starts a CLI subprocess and does not expose a native filesystem or command-executor injection point. The Sandbox adapter therefore runs the installed Codex CLI directly through bounded execution:

- the selected environment must already contain the Codex CLI
- each invocation gets isolated writable session state outside the Workspace unless the environment explicitly supplies its own authenticated state
- environment-owned Agent state and configuration remain outside AML's cleanup ownership
- provider-native credentials, model selection, reasoning, environment, and configuration are translated to the CLI boundary
- Codex runs with its working directory at the runtime-mapped Workspace path
- AML's outer Sandbox owns filesystem isolation, while Codex's access mode follows the Workspace policy
- FollowUps resume the same Codex session
- streamed command events are reduced to the final Agent response while tolerating provider diagnostics

The bridge transports Codex's native shell capability. JavaScript Tools are intentionally rejected in a Sandbox until AML has a secure transport for invocation-local Tool servers.

### OpenCode

OpenCode exposes a server-oriented SDK, but its installed CLI already provides the bounded protocol AML needs. The Sandbox adapter runs that installed CLI through bounded execution:

- the selected environment must already contain the OpenCode CLI
- each invocation receives isolated application state outside the Workspace
- provider-native configuration and credentials are supplied to the remote process
- an invocation-local Agent grants exactly the authored native Tools and denies undeclared capabilities
- FollowUps reuse the same OpenCode session
- command events are reduced to the final response

Isolation comes from explicit state and configuration rather than depending on version-specific convenience flags. The event parser accepts provider diagnostics while still requiring valid session events.

OpenCode does not currently require a server, port exposure, or a long-running `spawn` primitive. JavaScript Tools and structured output are rejected in a Sandbox until their remote transport and CLI contracts are implemented deliberately.

## Third-party Sandbox abstractions

[Sandbox SDK](https://sandbox-sdk.sh/) is a useful design reference:

- it models files, processes, ports, snapshots, normalized errors, conformance, and provider escape hatches as explicit capabilities
- it keeps provider construction options on individual adapters rather than flattening every provider into one configuration object

AML should learn from those provider boundaries without copying the complete feature surface or taking a dependency before the external contracts are stable and useful to AML.

### Deferred provider: AgentOS

[AgentOS](https://agentos-sdk.dev/docs/) is a promising lightweight provider because its in-process virtual
machines start quickly, support host-directory mounts, and expose literal process execution with environment,
working-directory, timeout, and cancellation controls. A prototype successfully mounted an AML Workspace, enforced
read-only mount policy, executed Pi's sandbox-backed shell tools, and persisted guest writes.

The provider is deferred because AML requires every supported Agent to work with every supported Sandbox. Pi runs
its SDK on the AML host and delegates only shell operations to the Sandbox runtime, so it worked with AgentOS's
default common software. Codex and OpenCode instead launch their complete CLI processes inside the Sandbox.
AgentOS's packages expose ACP-oriented adapters rather than the Codex `exec --json` and OpenCode JSON command
contracts used by AML.

Installing the standard Codex npm package at boot did not close the gap: a global install targeted a non-writable
location, while a writable-prefix install downloaded a platform-native executable that AgentOS could not run.
Supporting AgentOS without an exception in the compatibility matrix therefore requires one of:

- AgentOS packages that implement the normal CLI contracts expected by AML
- an AML ACP/session transport alongside the command runtime
- a deliberate host-Agent architecture in which AML owns each Agent's complete sandbox-backed tool surface

AgentOS should not be added to the public provider list or smoke matrix until one of these paths supports every
built-in Agent.

## Security boundaries

- Sandbox setup is trusted application configuration. Model-generated commands belong to the Agent running inside the Sandbox.
- The Sandbox runtime is trusted adapter infrastructure; it is not automatically a set of model-callable tools.
- Missing Agent binaries or runtimes fail clearly. AML never falls back to host execution.
- Environment variables and secrets are scoped to setup or Agent processes where possible, excluded from traces, and excluded from Workspace persistence.
- Read-only Workspace policy must be enforced by the provider’s attachment or synchronization mechanism, including setup commands.
- Exposed ports may contain bearer URLs, tokens, or required headers and must be treated as credentials.
- Agent termination, Workspace reconciliation, Sandbox release, and Workspace release need failure-safe ordering.

## Smoke matrix

The credentialed smoke matrix exercises the Cartesian product of supported Agent and Sandbox providers. It is separate from default unit tests because it may require credentials, containers, network access, remote infrastructure, and real model calls.

Each Agent has one canonical registration. Each Sandbox supplies the concrete environment needed for every registered Agent, including its image or snapshot, optional setup, and environment-specific configuration. Adding either axis therefore requires an explicit compatibility decision for the other axis rather than silently skipping unknown combinations.

Every selected cell runs the same end-to-end behavior:

1. acquire a durable Workspace
2. acquire the selected Sandbox and attach or hydrate that Workspace
3. run the selected Agent through its production Sandbox strategy
4. have the Agent read an unpredictable input and write an exact output
5. release the Sandbox and reconcile changes
6. verify the output from the durable Workspace

The matrix emits the normal AML trace tree plus clear cell start and failure context. A failed compatibility handshake is a valid, visible result; the smoke layer must not replace production adapters with permissive test wrappers.

Provider-specific environment preparation belongs to matrix configuration, while Agent configuration continues to use the same provider factories applications use. Credentials are injected only into the environment that needs them and must never be copied into the Workspace.

The matrix supports selecting one Agent, one Sandbox, either complete axis, or the full Cartesian product. Documentation should describe the covered combinations and shared guarantee without copying timestamps, durations, output sizes, or individual run results into this architecture notebook. Current results belong in test output and CI artifacts.

## Future considerations

These are possible extensions, not implementation phases:

- publish a convenient, versioned AML Agent image after the environment contract is stable
- add Sandbox providers only when they preserve provider-native environment configuration
- evaluate snapshots, warm starts, retries, and forks as control-plane capabilities
- add streaming processes or authenticated service access only when an Agent requires them
- revisit third-party Sandbox abstraction libraries when their packages and contracts are stable

## References

- [Daytona: Build a Coding Agent Using Codex SDK and Daytona](https://www.daytona.io/docs/en/guides/codex/codex-sdk-interactive-terminal-sandbox/)
- [Daytona snapshots](https://www.daytona.io/docs/en/snapshots/)
- [Modal Sandboxes](https://modal.com/docs/guide/sandboxes)
- [Cloudflare Sandbox custom images](https://github.com/cloudflare/sandbox-sdk/blob/main/docs/STANDALONE_BINARY.md)
- [Sandbox SDK](https://sandbox-sdk.sh/)
- [Pi Gondolin tool-operation bridge](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/gondolin/index.ts)
- [OpenCode SDK](https://opencode.ai/docs/sdk/)
- [Codex SDK subprocess implementation](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts)
