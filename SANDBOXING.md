# Sandboxing architecture notebook

Status: non-normative design and progress log

This document records the investigation and current direction for connecting AML Agents, Sandboxes, and Workspaces. It is intentionally separate from [`SPEC.md`](./SPEC.md). Decisions become normative only after they are moved into the specification and implemented.

## Current direction

The design was narrowed on 2026-07-29 after the first `SandboxRuntime` spike grew into a generic filesystem, process, image-build, and container-security layer.

The current decision is:

- AML coordinates Sandboxes; it does not provision their software.
- Applications select a provider-native image, snapshot, or environment that already contains the required Agent and tools.
- An explicit `setup` hook may install missing software after acquisition as a convenience, but hidden installation is forbidden.
- The common runtime starts with bounded process execution and a working directory. That contract is sufficient for Pi's shell bridge and for the implemented Codex and OpenCode CLI harnesses. File transfer, image building, snapshots, ports, and other provider features are not part of the baseline merely because one provider exposes them.
- Workspace attachment and reconciliation are lifecycle responsibilities, not a model-facing generic filesystem.
- The broad runtime spike is preserved in the named Git stash `wip broad sandbox runtime spike before responsibility reset`; it is not the implementation baseline.

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

## What the Daytona Codex guide proves

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

A child Sandbox does not call `WorkspaceProvider.acquire()` itself. AML owns the order:

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

The discarded broad spike included stream-first file CRUD, path resolution, process helpers, capability metadata, and provider-specific emulation. It proved that Pi tools can target an abstract runtime, but it also moved too much Sandbox-provider behavior into AML.

The replacement should begin with the smallest process boundary required to start an Agent:

```ts
interface SandboxRuntime {
  readonly cwd: string

  exec(
    command: string,
    options?: {
      cwd?: string
      env?: Readonly<Record<string, string>>
      signal?: AbortSignal
      timeoutMs?: number
    }
  ): Promise<{
    exitCode: number
    stdout: string
    stderr: string
  }>
}
```

The first implementation uses this literal executable/argument form. The explicit `setup` convenience is the only common string interpreted through a provider-selected shell.

Do not add features until a proof requires them:

- Long-running `spawn`, streaming output, and termination may be needed by interactive or server-based Agent harnesses, but the current Pi, Codex, and OpenCode proofs do not require them.
- Authenticated port exposure may be needed to connect a local SDK to an Agent server.
- Provider-native file transfer is needed internally for remote Workspace hydration, but it does not need to be Agent-facing runtime CRUD.
- Snapshots, forks, and warm starts are control-plane features outside the Agent runtime.
- A provider-native handle may remain an internal escape hatch for Workspace attachment and provider-specific optimizations.

The API should grow from Agent proofs, not from the union of Daytona, Modal, Cloudflare, Docker, or Sandbox SDK feature lists.

## Agent adapter strategies

### Pi

The current Pi proof replaces only Pi’s native `bash` operation with the common `exec()` runtime. The model can still read, write, inspect, and run files through shell programs without forcing generic filesystem CRUD into every Sandbox.

This native-tool bridge deliberately keeps Pi itself in the local AML process, so its Docker proof can use a small Alpine image containing only `sh`. Remote-harness Agents such as Codex and OpenCode remain responsible for selecting images that contain those Agents. Keep the Pi bridge only if it remains materially useful after the remote-harness proof.

### Codex

The Codex SDK starts a Codex CLI subprocess and does not expose a native filesystem or command-executor injection point. The implemented Sandbox adapter therefore runs the installed `codex exec --json` CLI directly through bounded `SandboxRuntime.exec()`:

- the selected environment must already contain the Codex CLI
- each AML invocation gets isolated temporary `CODEX_HOME` state outside the Workspace unless the provider explicitly supplies an already-authenticated home through `env`
- an explicit Codex home must be writable for session state and remains environment-owned, so AML neither replaces nor deletes it
- AML does not pass `--ignore-user-config`; an explicit home may therefore carry image- or user-owned Codex configuration, while the AML-owned temporary home remains isolated by default
- the provider's native `apiKey`, `baseUrl`, `model`, reasoning, environment, and recursive Codex `config` are translated to the same CLI boundary used by the SDK
- Codex runs with its working directory at the runtime-mapped Workspace path
- AML's outer Sandbox owns filesystem isolation, so the remote CLI runs with `--ignore-rules`; Codex's inner sandbox is set to match the Workspace access mode
- FollowUps resume the emitted Codex thread id
- JSONL events are reduced to the final Agent response, while remote providers that combine stdout and stderr may interleave non-JSON diagnostic lines

The bridge transports Codex's native shell capability. JavaScript Tools are intentionally rejected in a Sandbox until AML has a secure transport for invocation-local Tool servers.

### OpenCode

OpenCode exposes a server-oriented SDK, but its installed CLI already provides the bounded protocol AML needs. The implemented Sandbox adapter runs `opencode run --format json` through `SandboxRuntime.exec()`:

- the selected environment must already contain the OpenCode CLI
- each invocation receives isolated database and XDG state outside the Workspace
- provider-native OpenCode configuration, including provider API keys, is supplied through `OPENCODE_CONFIG_CONTENT`
- an invocation-local `aml` Agent grants exactly the authored native Tools and denies undeclared capabilities
- FollowUps reuse the emitted OpenCode session id
- the JSON event stream is reduced to the final response

This works with both OpenCode 1.18.7 and the Daytona default snapshot's older 1.1.35 CLI. The older CLI predates the optional `--pure` flag, so isolation comes from explicit state and configuration rather than a version-specific flag. Daytona also combines stdout and stderr; the parser accepts diagnostic lines while still requiring valid session events.

The proof showed that OpenCode does not currently require a server, port exposure, or a long-running `spawn` primitive. JavaScript Tools and structured output are rejected in a Sandbox until their remote transport and CLI contracts are implemented deliberately.

## Sandbox SDK assessment

As inspected on 2026-07-29, [Sandbox SDK](https://sandbox-sdk.sh/) is a useful design reference but too early to make an AML dependency:

- its core has a thoughtful capability map, files, processes, ports, snapshots, normalized errors, conformance tests, and a raw provider escape hatch
- it keeps provider construction options on individual adapters
- the repository is young, has no releases or tags, and its package source versions are `0.0.0`
- its packages were not available from npm under the documented names during this investigation
- it has no Docker adapter

AML should learn from its provider boundaries without copying the complete feature surface.

## Security boundaries

- Sandbox setup is trusted application configuration. Model-generated commands belong to the Agent running inside the Sandbox.
- The Sandbox runtime is trusted adapter infrastructure; it is not automatically a set of model-callable tools.
- Missing Agent binaries or runtimes fail clearly. AML never falls back to host execution.
- Environment variables and secrets are scoped to setup or Agent processes where possible, excluded from traces, and excluded from Workspace persistence.
- Read-only Workspace policy must be enforced by the provider’s attachment or synchronization mechanism, including setup commands.
- Exposed ports may contain bearer URLs, tokens, or required headers and must be treated as credentials.
- Agent termination, Workspace reconciliation, Sandbox release, and Workspace release need failure-safe ordering.

## Proof plan

### Smoke matrix

`npm run smoke -- [--agent <name>] [--sandbox <name>]` owns credentialed Agent × Sandbox proofs. Both filters are optional; omitting one selects that entire axis and omitting both selects the Cartesian product.

Agents have one canonical registration in `sdk/tests/smoke/smoke-matrix.ts`. Each Sandbox declares its concrete image, setup, and environment label for every Agent directly beside that provider. The selector still creates the Cartesian product automatically, while TypeScript requires a new Agent to receive an explicit environment in every Sandbox. The runner creates only selected tests, so the matrix has no `skipIf` branches and an unsupported production compatibility handshake fails visibly.

Smoke files use `.smoke.ts` or `.smoke.tsx` and a dedicated Vitest configuration. They remain outside default unit tests. Vitest filename filters do not override `test.include`, so the separate configuration is required even when a smoke filename is supplied explicitly.

Each cell emits the normal AML trace tree plus explicit start, proof, and failure records. The shared proof asks the selected Agent to read one random file through its declared `bash` capability, write another exact value, and verifies the persisted local Workspace after Sandbox release. Provider-specific images and setup commands are literal configuration in the Sandbox registry:

- `AML_CODEX_API_KEY`, `AML_CODEX_BASE_URL`, and `AML_CODEX_MODEL` for an explicit Codex-compatible Responses provider
- `AML_CODEX_HOME` for an already-authenticated Codex home that exists inside the selected environment

These Codex overrides are inputs to the repository's smoke CLI, not a second public configuration system. Applications configure `piAgent()`, `codexAgent()`, and `opencodeAgent()` through their provider-native factory options.

All three adapters use the same internal authority order:

1. provider defaults
2. user inputs, including factory options and portable per-Agent overrides
3. imperative AML configuration derived from the active Workspace, Sandbox, and authored capabilities

`defu` expresses this precedence for known plain configuration tables by receiving the highest-priority layer first. Bespoke final objects handle arrays, client and callback identities, Tools, MCP definitions, and capability policy. This avoids `defu`'s array concatenation where replacement is required and ensures user input cannot weaken the final AML execution boundary.

The matrix is intentionally honest about current support. Pi has a narrow runtime bridge. Codex and OpenCode have production CLI adapters; the smoke runner uses those adapters rather than a permissive test wrapper.

The first complete matrix run on 2026-07-29 produced the expected baseline:

- Pi × Local passed with a persisted 36-byte proof in 22.9 seconds.
- Pi × Docker passed with a persisted 36-byte proof in 29.2 seconds.
- Pi × Daytona passed with a persisted 36-byte proof in 14.1 seconds.
- all six Codex/OpenCode cells failed at the production compatibility handshake with `Agent provider "<name>" cannot run inside Sandbox provider "<name>"`.

Those failures occurred after Sandbox acquisition and were released through the normal AML lifecycle. No Codex or OpenCode model request was made. This is the baseline the remote-harness work must turn green.

The subsequent OpenCode implementation turned all three of its cells green with the same proof:

- OpenCode × Local passed with a persisted 36-byte proof in 32.6 seconds.
- OpenCode × Docker passed with a persisted 36-byte proof in 28.3 seconds.
- OpenCode × Daytona passed with a persisted 36-byte proof in 17.7 seconds.

The Docker cell used an explicit smoke-only setup command to install OpenCode in a disposable `node:26` container. The Daytona default snapshot already contains OpenCode 1.1.35; its standard user cannot replace global packages, reinforcing that images and snapshots own installed Agent versions.

These live runs exposed two common Local runtime requirements: the child `PWD` environment must match the effective `cwd`, and bounded execution must close stdin because the runtime has no input-stream contract. Without the first, OpenCode selected the host repository instead of the attached Workspace. Without the second, OpenCode waited indefinitely while probing piped input.

Codex × Local subsequently passed the same real model and file proof in 7.2 seconds. The smoke used an explicitly configured writable `CODEX_HOME` with a local-only link to the machine's existing ChatGPT authentication, then removed the complete temporary home. No authentication material was copied into the Workspace, Docker, or Daytona.

Codex × Docker and Codex × Daytona subsequently reached OpenAI through the real CLI bridge with `gpt-5.3-codex`. The first attempts stopped at the provider until API quota was enabled. The completed proofs exposed three environment and version details:

- the Daytona image's Codex 0.128.0 rejects the newer `agents.enabled=false` shape, so AML uses the stable `features.multi_agent=false` override to disable subagents
- older Codex versions may leave a background plugin-cache clone settling immediately after the main process exits, so cleanup retries removal of AML-owned temporary state through the same bounded runtime
- the initial `node:26-alpine` fixture did not contain Bash, so the Codex cell now directly selects `node:26`; the Docker Sandbox itself remains image-only and performs no implicit provisioning

The final complete matrix run passed all nine cells in 119.7 seconds. Every model used its declared shell capability to read a random `input.txt`, write the exact random 36-byte `output.txt`, and persisted that file through Workspace reconciliation:

- Codex × Daytona passed in 8.4 seconds.
- Codex × Docker passed in 16.2 seconds.
- Codex × Local passed in 4.9 seconds.
- OpenCode × Daytona passed in 18.3 seconds.
- OpenCode × Docker passed in 19.4 seconds.
- OpenCode × Local passed in 25.5 seconds.
- Pi × Daytona passed in 16.5 seconds.
- Pi × Docker passed in 4.6 seconds.
- Pi × Local passed in 4.7 seconds.

The subsequent fixture cleanup made every environment literal in the matrix registry and changed the Codex and OpenCode Docker cells to `node:26`. A targeted rerun kept all three Docker cells green: Codex in 40.1 seconds including the first image pull, OpenCode in 20.8 seconds, and Pi on `alpine:3.22` in 3.5 seconds.

### Proof 1: narrow local composition

- [x] Replace the broad experimental runtime with the minimal execution contract.
- [x] Simplify `dockerSandbox()` to a named image, Workspace mount, command execution, and release.
- [x] Remove Dockerfile building and generic Docker filesystem emulation.
- [x] Implement the explicit setup hook in Local and Docker providers.
- [x] Run one unchanged real Pi workflow through Local and Docker over `localWorkspace()`.
- [x] Prove the real model reads and writes the mounted Workspace through runtime-backed bash.
- [x] Prove setup failures are surfaced without host fallback.

### Proof 2: same contract on Daytona

- [x] Implement `daytonaSandbox()` with Daytona-native configuration.
- [x] Hydrate a local Workspace at Daytona's writable guest working directory.
- [x] Run the same setup and Agent workflow without a Daytona-specific Agent adapter.
- [x] Reconcile writable additions, changes, and deletions before Sandbox release.
- [x] Prove a second fresh Daytona Sandbox sees the persisted result.

Passing Proof 2 establishes the important composition claim: one Agent adapter can run through Local, Docker, and Daytona without an Agent × Sandbox integration.

### Proof 3: Agent-specific process needs

- [x] Run `opencodeAgent()` through an installed remote CLI harness on Local, Docker, and Daytona.
- [x] Prove bounded execution is sufficient for OpenCode without adding `spawn` or ports.
- [x] Implement and deterministically test the installed Codex CLI bridge, including FollowUp resume.
- [x] Run `codexAgent()` through Local with an explicitly configured authenticated Codex home.
- [ ] Run `codexAgent()` through Docker and Daytona with an explicit Responses-compatible provider key.
- [ ] Verify credentials are available only where needed and never persisted to the Workspace.

### Later

- [ ] Publish a convenient AML Agent image after the runtime contract is stable.
- [ ] Add Modal and Cloudflare Sandbox providers using their native environment configuration.
- [ ] Evaluate snapshots for warm starts, retries, and forks.
- [ ] Revisit Sandbox SDK if it publishes stable packages.

## Current progress

- [x] AML Sandbox and Workspace lifecycle contracts exist.
- [x] `localWorkspace()` provides a durable local materialization.
- [x] Pi, Codex, and OpenCode adapter seams have been investigated.
- [x] Sandbox SDK and Daytona’s Codex remote-harness example have been inspected.
- [x] The 2,816-line broad spike is preserved in a recoverable Git stash and removed from the implementation baseline.
- [x] The implemented common runtime contains only access/root/cwd metadata and bounded literal `exec()`.
- [x] `localSandbox()` and image-only `dockerSandbox()` implement that same runtime.
- [x] Local and Docker setup hooks run explicitly before descendant Agents.
- [x] Unit tests, Local tests, Docker tests, and a live Docker integration pass.
- [x] A credentialed real Pi model read and wrote exact Workspace files through both Local and Docker using the unchanged Agent workflow.
- [x] `daytonaSandbox()` is the first remote provider and keeps Daytona-native client and creation configuration behind normalized root `image` or `snapshot` selection.
- [x] Its full-transfer lifecycle mirrors additions, changes, and deletions before cleanup; the selected host and Daytona environment must contain `tar`.
- [x] A credentialed real Pi model read and wrote exact Workspace files through Daytona using the unchanged Local/Docker workflow.
- [x] The live result was reconciled back to the local Workspace before the Daytona Sandbox was deleted.
- [x] A second fresh Daytona Sandbox and Pi session read the reconciled result through the same Workspace.
- [x] A remote OpenCode process runs beside its Workspace through the same bounded runtime on Local, Docker, and Daytona.
- [x] The OpenCode proof required no server, port exposure, or long-running process API.
- [x] The Codex CLI bridge is deterministic-test green and its exact command shape reaches the current Responses transport.
- [x] A real ChatGPT-authenticated Codex process read and wrote the Local Sandbox Workspace through the same bridge, with a persisted 36-byte proof.
- [x] OpenCode Go's undocumented `/responses` route was probed rather than assumed compatible. It returned HTTP 200 but exhausted the requested output budget with an empty `output` array, and a real Codex turn consequently produced no message or Tool call. Its documented APIs remain Chat Completions and Messages, so it is not used as a Codex credential fallback.
- [x] Codex's Docker and Daytona cells reach OpenAI with an explicit API key and an available API model; local ChatGPT auth is not copied into remote Sandboxes.
- [x] A single complete run passed all nine Agent × Sandbox cells with persisted 36-byte file proofs.

## References

- [Daytona: Build a Coding Agent Using Codex SDK and Daytona](https://www.daytona.io/docs/en/guides/codex/codex-sdk-interactive-terminal-sandbox/)
- [Daytona snapshots](https://www.daytona.io/docs/en/snapshots/)
- [Modal Sandboxes](https://modal.com/docs/guide/sandboxes)
- [Cloudflare Sandbox custom images](https://github.com/cloudflare/sandbox-sdk/blob/main/docs/STANDALONE_BINARY.md)
- [Sandbox SDK](https://sandbox-sdk.sh/)
- [Pi Gondolin tool-operation bridge](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/gondolin/index.ts)
- [OpenCode SDK](https://opencode.ai/docs/sdk/)
- [Codex SDK subprocess implementation](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts)
