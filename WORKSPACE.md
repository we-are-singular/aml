# Workspace architecture notebook

Status: implemented, including the 0.8 active-filesystem and Agent-staging expansion

This document records the architecture and current direction for AML Workspaces. It is intentionally separate from [`SPEC.md`](./SPEC.md). Decisions become normative only after they are accepted and moved into the specification; implementation status remains explicit here.

The repository contains the accepted Workspace implementation. It proves durable identity, optional cross-process locking, one provider-owned materialization, atomic revision publication, Sandbox attachment, save-after-execution, nearest-filesystem authored File inputs, per-Agent staging, and failure-safe release.

## Product truths

A Workspace is three user-visible things:

1. the current working directory in which an Agent operates
2. the initial files available before that Agent starts
3. the policy describing which files are persisted after execution ends

The following constraints refine that model:

- Every active Workspace is exposed to AML as a directory, regardless of where its durable state lives.
- The default provider is local. “Local” means the materialization lives on the machine running AML; it does not
  imply that AML should mutate the application's repository in place.
- A remote provider materializes its state into a safe local directory before local execution, or supplies an
  equivalent materialization that a Sandbox provider can attach.
- Revision-backed providers use AML's shared Workspace persistence layer. They may choose `"archive"` or `"folder"`;
  omitted `format` defaults to `"archive"`. Archive always means AML-owned `tar.gz`, while folder means one
  provider-native directory or object prefix per revision.
- Storage providers implement transport operations and atomic metadata publication. They do not implement archive
  creation, extraction, revision selection, retention, or persistence-pattern matching.
- Saving is opt-in. It defaults to successful evaluations only; `save.on: "always"` also publishes failed work.
- `<File>` writes a local UTF-8 source or resolved text, including Agent output, through the nearest active filesystem before later siblings run.
- `<Include path>` reads the nearest active filesystem live; `<Include src>` reads an application-owned local file live.
- `<Skill>` stages a complete local Agent Skill package at `.agents/skills/<skill-name>/` for one Agent session. Skill staging is ephemeral unless an application deliberately authors the same files into its Workspace.
- Sandbox and Workspace remain separate responsibilities. Workspace owns files and persistence. Sandbox owns
  execution isolation and attachment.

## Current contract and boundaries

The implemented `<Workspace>` contract accepts `id`, `provider`, `cwd`, `load`, `lock`, `save`,
`writeConcurrency`, and `children`:

```tsx
<Workspace id="review-42" provider={repositoryWorkspace}>
  <Sandbox provider={daytona}>
    <Agent>Implement and test the change.</Agent>
  </Sandbox>
</Workspace>
```

The provider acquires a lease containing `directory`, `handle`, `id`, `save()`, and `release()`. AML enters the
Workspace before evaluating descendants, passes an immutable materialization reference to descendant Sandboxes,
applies the authored save policy, then releases the lease.

The built-in local provider points directly at one existing directory. Filesystem writes are already durable, so its
`save()` method only verifies lock health.

`id` is optional and defaults to `crypto.randomUUID()`. Explicit identities remain the durable isolation boundary for resumable
Workspaces such as a client ID, user ID, Slack channel ID, or thread ID. Provider authorization must still prevent a
caller from acquiring another caller's identity; naming is partitioning, not access control.

The 0.8 contract adds host-source File copying, guest-side File and Include operations through portable Sandbox filesystem methods, and per-Agent staging for oversized local Includes and complete Skill packages. Bulk directory inputs and Git repositories as input material remain outside the component surface.

The new design should evolve the proven lifecycle rather than create a parallel Workspace abstraction.

## Goal

AML should provide one portable Workspace lifecycle while allowing providers to implement storage and transfer
differently:

```text
authored Workspace
      │
      ├── cwd
      ├── initial entries
      └── persistence policy
              │
              ▼
     Workspace provider
              │
              ▼
   WorkspacePersistence
      ┌───────┴────────┐
      │                │
   archive           folder
   revision          revision
      │                │
      └───────┬────────┘
              ▼
   WorkspaceStorageAdapter
      ┌───────┴──────────┐
      │                  │
     S3             filesystem
      │                  │
      └────────┬─────────┘
              ▼
     active materialization
              │
              ▼
      attached to Sandbox
              │
              ▼
            Agent cwd
```

The authored tree describes observable filesystem behavior. Persistence format is provider configuration, not a
`<Workspace>` prop: callers may choose whether one provider stores revisions as AML-owned tarballs or
provider-native folders without exposing R2, volume, or Sandbox SDK APIs as universal AML concepts. Omission means
`"archive"`.

## Workspace and Sandbox topology

`<Workspace>` remains the highest component and durable lexical owner:

```tsx
<Workspace id="review-42" provider={workspaceStore}>
  <File path="task.md">Review the current implementation.</File>

  <Sandbox provider={remoteSandbox} access="read-write">
    <Agent>Complete task.md.</Agent>
  </Sandbox>
</Workspace>
```

The Sandbox physically contains an attached or hydrated copy of that Workspace while it runs, but it does not own
the Workspace identity or persistence lifecycle. Reversing the component nesting would not remove the transfer
requirement: bytes must still move whenever durable storage, the AML coordinator, and execution live in different
places.

The simple correct remote lifecycle is:

```text
durable revision
      ↓ restore
host staging tree
      ↓ Sandbox hydrate
guest working tree
      ↓ Sandbox reconcile
host staging tree
      ↓ publish
durable revision
```

This performs two transfer boundaries in each direction for a remote object store plus a remote Sandbox. That is an
accepted v1 cost, not the desired final optimization. It preserves one provider-neutral source of truth between
sequential Sandboxes and gives AML a safe place to apply authored inputs and persistence selection.

The Workspace materialization handle remains an optimization seam. A compatible pair may transfer a revision
artifact directly between durable storage and the Sandbox, or attach a provider-native volume, provided it preserves
the same observable lifecycle, authored overlays, selected persistence, deletion behavior, and writer fencing. AML
should add such negotiation only after a measured remote path proves the extra transfer material.

## Terminology

Keep these concepts distinct:

- **Workspace identity**: the authored durable identity, such as `review-42`
- **materialization root**: the runtime-visible directory containing the complete active Workspace
- **logical cwd**: a relative path beneath the materialization root where the Agent starts
- **guest root**: the Sandbox provider's path corresponding to the materialization root
- **guest cwd**: the Sandbox path corresponding to the logical cwd
- **filesystem authoring operation**: a File write, Include read, or Agent staging copy applied in authored order before dependent work
- **persistence selection**: the paths eligible for saving after execution
- **persistence format**: the closed `"archive" | "folder"` representation selected when constructing a
  revision-backed provider
- **storage adapter**: the provider-specific implementation of durable reads, writes, deletion, listing, scoped
  access, and atomic metadata publication
- **revision**: one provider-published durable Workspace state
- **Workspace index**: provider-independent `workspace.json` metadata identifying the current revision and retained
  history

For example:

```text
host materialization: /tmp/aml/workspaces/run-123
logical cwd:          packages/api
guest root:           /workspace
guest cwd:            /workspace/packages/api
```

The host materialization path is provider infrastructure. It must never leak into prompts or become a portable Agent
path.

## Responsibility contract

### AML runtime

AML owns:

- validating authored Workspace paths and persistence patterns
- entering the Workspace before its descendants
- applying AML-owned input entries in authored order
- resolving the logical cwd beneath the materialization root
- selecting the nearest active filesystem for File and Include
- preparing invocation-owned Agent staging and Skill discovery before dependent Agents start
- preserving lifecycle order across Workspace, Sandbox, and Agent boundaries
- requesting persistence after descendants and Sandbox reconciliation complete
- preserving evaluation, persistence, and release failures without masking their causes
- tracing preparation, execution, persistence, and cleanup
- the reusable Workspace persistence implementation, including file selection, revision metadata, retention, and
  tar/gzip handling

AML does not own:

- the generic filesystem and artifact APIs exposed by each remote provider beyond portable stat, complete-file read, and atomic replacement write
- provider credentials, network clients, or provider-native byte transport
- Sandbox guest paths
- Git credentials, hosting policy, or automatic pushes
- image building or Agent installation

### Workspace provider

A Workspace provider owns:

- acquiring provider-native authority when direct mutable persistence requires it
- creating or exposing one active materialization
- restoring the selected durable revision before acquisition completes
- persisting the requested output selection
- publishing durable revisions atomically where the backend permits it
- mapping provider-native conflicts into `WorkspaceConflictError`
- cleaning temporary materialization and releasing locks or leases
- documenting crash, concurrency, deletion, and consistency behavior

The provider may optimize attachment through its opaque handle. Descendants do not receive acquisition, save, or
release authority.

A revision-backed provider should normally be built through `createPersistentWorkspaceProvider()` and a
`WorkspaceStorageAdapter`. In that shape, the shared persistence layer owns materialization, selection, archive or
folder revision handling, `workspace.json`, and retention. The adapter owns the backend operations needed to fulfill
that lifecycle. Direct in-place and provider-native mounted Workspaces may continue to implement
`WorkspaceProvider` without revision persistence when the durable directory is already the active materialization.

### Sandbox provider

The Sandbox provider owns:

- attaching, mounting, or hydrating the active Workspace
- mapping the logical cwd to a guest cwd
- enforcing the declared access level
- reconciling writable guest changes, including deletions, before Workspace persistence
- rejecting a Workspace it cannot faithfully attach

The Sandbox provider must not save durable Workspace state independently. Reconciliation updates the active
materialization; the outer Workspace lifecycle publishes it.

### Agent adapter

The Agent adapter owns:

- starting the Agent at the effective cwd supplied by the active execution environment
- using filesystem-discovered instructions and Skills according to that Agent's native behavior
- refusing execution when its Sandbox or cwd contract cannot be honored

It does not interpret Workspace persistence patterns or upload files.

## Authored surface

The implemented Workspace lifecycle surface is:

```ts
interface WorkspaceProps {
  id?: string
  provider?: WorkspaceProvider
  cwd?: string
  lock?: boolean
  load?:
    | boolean
    | {
        revision?: "current" | string
        include?: readonly string[]
        exclude?: readonly string[]
      }
  save?:
    | boolean
    | {
        include?: readonly string[]
        exclude?: readonly string[]
        gitignore?: boolean
        on?: "success" | "always"
        retention?: number
      }
  writeConcurrency?: "serial" | "parallel"
  children?: AmlRenderable
}
```

The following shape illustrates authored Workspace input, guest-side inclusion, and per-Agent Skill staging:

```tsx
<Workspace
  id="review-42"
  provider={workspaceStore}
  cwd="repo"
  save={{
    include: ["repo/src/**", "repo/tests/**", "report.md"],
    exclude: ["**/node_modules/**"],
    on: "always",
  }}
>
  <File path="AGENTS.md">Work only inside this Workspace. Run targeted tests before finishing.</File>

  <Sandbox provider={sandboxProvider}>
    <Agent>
      <Skill src="./skills/evidence" />
      <Include path="AGENTS.md" maxBytes={4_000} />
      Complete the requested work.
    </Agent>
  </Sandbox>
</Workspace>
```

Archive is the default. A revision-backed provider only needs `format` when folder representation is desired:

```ts
const workspaceStore = s3Workspace({
  bucket,
  format: "folder",
})
```

`format` is deliberately not a `<Workspace>` prop. The authored lifecycle does not change when the same identity is
stored through another representation or provider.

Bulk directory copying is deliberately not an AML component. Applications can prepare local directories in ordinary
JavaScript before returning AML, while a sandboxed `<Script>` can clone, generate, or copy files inside the execution
environment. Git is likewise not required as a separate primitive when the selected environment contains Git.

## Lifecycle

One staged Workspace evaluation should have the following observable order:

1. validate the Workspace identity, cwd, persistence policy, and provider
2. acquire exclusive writer authority unless `lock={false}`
3. create a safe materialization
4. restore the provider's current durable revision
5. evaluate and apply authored entries encountered before executable descendants
6. validate that the logical cwd exists and remains beneath the materialization root
7. attach or hydrate descendant Sandboxes
8. run descendant Agents and sandboxed Script effects against the active guest tree at the mapped cwd
9. reconcile each writable Sandbox into the active materialization
10. select the paths allowed by the persistence policy
11. ask the Workspace provider to publish the selected state
12. release the provider lease and temporary materialization
13. return the child result or rethrow the preserved failure

An in-place local Workspace collapses restore, materialization, and persistence into the configured directory.
Because its writes are immediately durable, it cannot honestly provide transactional or selective-save semantics.

With the default `writeConcurrency="serial"`, each writable root Sandbox reconciles before the next writable root
Sandbox acquires its attachment. The permit covers acquisition, hydration, execution, reconciliation, and release.
Read-only Sandboxes remain parallel, and parallel Agents inside one Sandbox share that Sandbox's live filesystem.
`writeConcurrency="parallel"` opts out for shared mounts or callers willing to accept provider-specific races.

## Authored order and the bottom-up evaluator

Workspace preparation does not require reversing AML's evaluator.

`<Workspace>` is a lexical resource scope. AML enters it before evaluating its children. Children then resolve in
authored order, while each individual component completes after its own descendants:

```tsx
<Workspace>
  <File path="task.md">Inspect the API.</File>
  <Sandbox provider={sandboxProvider}>
    <Agent>
      <Skill src="./skills/review" />
      <Include path="task.md" />
      Complete the task.
    </Agent>
  </Sandbox>
</Workspace>
```

The observable order is:

1. enter Workspace
2. resolve and write `task.md`
3. acquire and hydrate Sandbox from the updated materialization
4. prepare the Agent's ephemeral `.agents/skills/review/` package
5. read the live guest `task.md`
6. start the Agent
7. reconcile and persist the Workspace

This also permits generated files:

```tsx
<File path="plan.md">
  <Agent>Generate a focused implementation plan.</Agent>
</File>
```

The nested Agent runs first because `<File>` needs its resolved text, then `<File>` writes that result. A later sibling
Agent can consume `plan.md`.

The same composition may occur inside an Agent before any Sandbox is active:

```tsx
<Workspace provider={workspaceStore}>
  <Agent>
    <File path="report.md">
      <Agent>Produce the report.</Agent>
    </File>
    Read report.md and act on its findings.
  </Agent>
</Workspace>
```

Here the inner Agent runs, File writes its result, and the outer Agent starts afterward. File is a materialization side effect and contributes no duplicate file content to the outer prompt. File inside an active Sandbox writes the live guest through the portable Sandbox filesystem so it cannot update only a stale host replica.

Authored order is therefore meaningful. A File placed after an Agent does not retroactively affect that Agent. A Skill belongs to its containing Agent plan and is prepared before that Agent's prompt resolves; it does not mutate prior or sibling Agent sessions.

## `<File>`

`<File>` is an AML-owned filesystem effect, not a model-facing tool. It writes resolved children or a local source through the nearest active filesystem:

```tsx
<File path="AGENTS.md">Inline text</File>

<File src="./fixtures/policy.md" path=".agents/context/policy.md" />
```

Rules:

- `path` is the destination relative to the nearest active filesystem root.
- Inside Sandbox, File writes the live guest; otherwise it writes the active Workspace materialization.
- File without either scope rejects. A read-only Sandbox rejects before writing.
- Exactly one content source is required: inline children or application-owned local `src`.
- Inline children use ordinary AML evaluation and may resolve to an empty text file.
- `src` reads a local UTF-8 file live relative to `AmlRuntime.cwd`; it is never resolved against Workspace or Sandbox.
- Writes replace regular files.
- Parent directories are created when needed.
- Destination paths cannot be absolute, contain traversal, or escape through symlinks.
- File writes happen atomically where the active filesystem permits it.
- Before Sandbox acquisition, File writes to the host staging materialization.
- Inside an active Sandbox, File uses `SandboxRuntime.writeFile()` rather than a shell command.
- File returns no prompt text after materializing its content.

Deferred File extensions:

- explicit append or create-only modes
- whether binary inputs belong in `<File>` through a `Uint8Array` prop or require a separate entry API
- whether input entries may declare read-only intent before Sandbox attachment

## Agent staging beside Workspaces

`<Skill>` is owned by one Agent session rather than by Workspace. It accepts a local package directory containing `SKILL.md`, validates the package metadata and tree, and copies the complete package to the canonical `.agents/skills/<name>/` suffix beneath an Agent-visible staging root. Provider profiles map that concrete package to native discovery when available. Otherwise AML contributes metadata-only prompt guidance that tells the Agent when and where to read it.

`<Include src>` shares the same staging owner when `maxBytes` prevents inlining. AML copies that application-owned file to an invocation-private Agent-visible path and renders a bounded read instruction. `<Include path>` never copies: it reads the nearest active filesystem live and references that same path when oversized.

Example:

```tsx
<Workspace provider={workspaceStore}>
  <Sandbox provider={sandboxProvider}>
    <Agent>
      <Skill src="./skills/review" />
      <Include path="change.patch" maxBytes={8_000} />
      Review the current change.
    </Agent>
  </Sandbox>
</Workspace>
```

Agent staging is ephemeral and cleaned with the provider session. It does not silently become durable Workspace state. An application that deliberately wants a persistent `.agents/skills` tree may author or restore those files as ordinary Workspace content, but `<Skill>` still declares which package belongs to the current Agent plan. Remote registry installation and package-script execution remain outside AML.

## Path model and cwd

Portable paths are relative to the lexical owner that consumes them:

- Workspace `cwd`, Sandbox `root`, and persistence patterns are relative to the Workspace materialization root.
- File destinations and Include `path` sources are relative to the nearest active filesystem root.
- Agent staging exposes canonical `.agents/skills/<name>/` and AML-generated Include paths inside the Agent-visible ephemeral root.
- Git repository destinations

Path validation must be lexical and physical:

1. reject empty, absolute, and traversal-bearing portable paths
2. resolve the candidate beneath the materialization root
3. resolve existing parent symlinks
4. verify that the physical destination remains beneath the physical materialization root
5. perform the operation without following a newly swapped path where practical

The initial contract should not claim hostile concurrent-filesystem safety when Node filesystem APIs cannot provide
an atomic beneath-root operation. Sandbox confinement remains necessary for untrusted model-controlled work.

Proposed cwd behavior:

- `cwd` defaults to `.`
- it is relative to the materialization root
- it must exist as a directory before an Agent starts
- each descendant outer Sandbox receives the logical cwd
- a nested Sandbox may narrow the root or cwd according to existing Sandbox rules
- an Agent without a Sandbox still receives the Workspace cwd through its provider execution context

That final item is a contract change. The current materialization reference is primarily an attachment capability for
Sandbox providers; the revised implementation must make cwd meaningful for trusted local Agent execution as well.

## Input layering

A restored Workspace and authored input entries may target the same paths. The precedence must be deterministic.

Proposed order:

1. create an empty materialization
2. restore the provider's durable revision
3. apply authored inputs in authored order

Later authored entries therefore overlay restored state and earlier entries. This makes current task files and instructions authoritative for the new run while allowing selected outputs from a previous run to remain available. Per-Agent Skill staging is separate and does not participate in Workspace layering unless those files were independently authored as Workspace content.

Inputs and persisted state must not be confused:

- an input entry describes what this evaluation starts with
- the provider revision describes what a previous evaluation saved
- the persistence policy describes what may enter the next revision

## Persistence selection

The Workspace must state what survives after the run. Storage representation does not change selection semantics.

Illustrative policy:

```ts
{
  include: ["report.md", "artifacts/**"],
  exclude: ["artifacts/**/*.tmp"],
  on: "always",
}
```

Implemented rules:

- patterns are relative to the materialization root
- includes are evaluated before excludes
- automatic discovery respects nested `.gitignore` files by default
- explicit includes override `.gitignore`; explicit excludes always win
- unmatched paths are not part of the newly published revision
- deletions beneath included paths are preserved by their absence from the new revision
- directories required to represent matching descendants are included
- selected symlinks reject and never pull external file content into persistence
- secrets and provider-owned control files are excluded independently of user patterns
- persistence occurs only after writable Sandbox reconciliation completes
- the selected state is published as one logical revision

Publishing a new selected revision is clearer than merging matching files into the previous revision. Merge semantics
make deletion, exclusions, renamed files, and provider consistency difficult to reason about.

Omitted `save` means no persistence. `save: true` discovers the entire tree subject to `.gitignore`, publishes only
after success, and retains one current revision. `save.on: "always"` opts into publishing failed work. Selecting no
files publishes an empty revision, which makes deliberate reset/save-only workflows coherent. AML uses Globby syntax
for portable include and exclude arrays.

## Provider contract direction

The current provider contract can remain recognizable while making persistence selection explicit:

```ts
interface WorkspaceAcquireRequest {
  evaluationId: string
  id: string
  load:
    | false
    | {
        revision: "current" | string
        include?: readonly string[]
        exclude: readonly string[]
      }
  save: boolean
  signal: AbortSignal
}

interface WorkspaceSaveRequest {
  include?: readonly string[]
  exclude: readonly string[]
  gitignore: boolean
  outcome: "success" | "failure"
  retention: number
  signal: AbortSignal
}

interface WorkspaceLease<Handle = unknown> {
  directory: string
  handle: Handle
  id: string
  save(request: WorkspaceSaveRequest): Promise<void>
  release(): Promise<void>
}
```

The shared persistence engine performs pattern expansion and builds a validated file manifest rather than passing
raw globs to storage adapters:

```ts
interface WorkspaceSaveRequest {
  files: readonly WorkspaceFileManifestEntry[]
  outcome: "success" | "failure"
  signal: AbortSignal
}
```

Passing a manifest has useful properties:

- providers do not need to implement identical glob engines
- AML validates every selected path once
- archive and folder formats receive the same logical selection
- sizes, modes, and entry kinds let AML enforce persistence limits before archiving

AML therefore owns the safe materialization walk. Direct `WorkspaceProvider` implementations may consume the save
request themselves, while providers created through `createPersistentWorkspaceProvider()` delegate selection and
encoding to WorkspacePersistence. `WorkspaceStorageAdapter` never receives or interprets globs.

## Shared Workspace persistence

Revision-backed providers should not each reimplement selection, revision metadata, retention, or tar/gzip. AML
should expose one reusable persistence engine:

```ts
const provider = createPersistentWorkspaceProvider({
  storage: customStorage,
})
```

The public responsibilities are:

- `WorkspacePersistence`: the provider-independent lifecycle implementation
- `WorkspaceStorageAdapter`: the transport and storage boundary implemented by built-in and user-defined providers
- `createPersistentWorkspaceProvider()`: the normal factory that combines them into the existing
  `WorkspaceProvider` contract

`WorkspaceFilesystem` is not the abstraction name. S3 and R2 are not live
filesystems even when they can represent relative paths.

The provider factory constructs and injects persistence. `<Workspace>` remains declarative and never constructs
network clients, storage adapters, or credential-bearing services during evaluation.

### Workspace index

Every provider using shared persistence stores one provider-independent `workspace.json` outside the active
materialization:

```json
{
  "version": 1,
  "current": "3a8ee22d-79eb-4aba-bc41-f22cbf67ed52",
  "revisions": [
    {
      "id": "3a8ee22d-79eb-4aba-bc41-f22cbf67ed52",
      "createdAt": "2026-07-30T02:11:04.822Z",
      "format": "archive",
      "path": "revisions/3a8ee22d-79eb-4aba-bc41-f22cbf67ed52.tar.gz"
    },
    {
      "id": "c6cb1dc0-3ae6-4775-8bcc-61dcbe6b5bc2",
      "createdAt": "2026-07-29T21:40:11.183Z",
      "format": "folder",
      "path": "revisions/c6cb1dc0-3ae6-4775-8bcc-61dcbe6b5bc2/"
    }
  ]
}
```

The schema stores format per revision rather than once per Workspace. A provider configured to save new revisions
as `"folder"` can therefore restore an older `"archive"` current revision and migrate naturally on its next save.
Changing format must never silently initialize an empty Workspace.

The index is authoritative:

- `current` selects the committed revision; timestamps and backend listing order do not
- `revisions` is ordered newest first and contains the bounded retained history
- revision paths are relative, validated, and derived by AML rather than accepted as arbitrary external locations
- `workspace.json` and any direct-provider lock files are control data and are never materialized into the Agent
  Workspace
- unknown schema versions or formats reject rather than starting fresh

Revision IDs default to `crypto.randomUUID()`. `createdAt` supports display and retention diagnostics, but wall-clock
ordering does not decide the committed current revision.

### Persistence format

Every provider built through `createPersistentWorkspaceProvider()` saves new revisions in one of two formats:

```ts
type WorkspacePersistenceFormat = "archive" | "folder"
```

The choice is closed in the initial public API and defaults to `"archive"`:

- `"archive"` means exactly one AML-created `tar.gz` file per revision
- `"folder"` means one provider-native directory or object prefix per revision

There is no public codec interface and no ZIP option. Archive construction, validation, extraction, compression,
limits, entry policy, and tar implementation are closed AML responsibilities. A storage adapter uploads and
downloads the resulting opaque tarball without knowing how it was created.

Folder persistence remains a logical revision even when its physical representation differs:

- filesystem storage uses a real revision directory
- S3-compatible stores use one object prefix per revision
- partial folder uploads remain unreferenced until `workspace.json` commits
- folder restoration enumerates the selected revision only; it does not merge with another revision

Archive and folder both use the same selection, publication, retention, and restore lifecycle. Folder conformance
covers enumeration, deletion, empty directories, modes, symlinks, and partial-upload behavior.

### Storage adapter contract

Users can implement a durable Workspace backend without understanding revision publication, retention, archive
handling, or AML evaluation. The adapter provides these capabilities:

```ts
interface WorkspaceStorageAdapter {
  acquire(request: WorkspaceStorageAcquireRequest): Promise<WorkspaceStorageLease>
}

interface WorkspaceStorageLease {
  read(path: string): Promise<WorkspaceStorageObject | undefined>
  write(
    path: string,
    body: WorkspaceStorageBody,
    options?: WorkspaceStorageWriteOptions
  ): Promise<WorkspaceStorageVersion>
  delete(paths: readonly string[]): Promise<void>
  list(prefix: string): Promise<readonly WorkspaceStorageEntry[]>
  release(): Promise<void>
}
```

Bodies should support streaming so adapters do not need to buffer large archives. Paths use a normalized,
provider-independent relative namespace. Version tokens remain opaque to AML: the S3 adapter uses an ETag, while the
filesystem adapter uses a content digest.

The adapter contract has two concurrency modes. With locking enabled, acquisition owns the Workspace identity until
release. With `lock={false}`, acquisition may overlap, but publishing `workspace.json` must still support atomic
replacement and reject an obsolete expected version.

Backend mappings include:

| Adapter            | Default run lock                  | Atomic index publication                                |
| ------------------ | --------------------------------- | ------------------------------------------------------- |
| S3 or R2           | fixed renewable `lock.json` lease | conditional object write                                |
| mounted filesystem | fixed renewable filesystem lease  | short lock plus same-filesystem conditional replacement |

An adapter that cannot meet atomic publication must reject persistent provider construction or saving rather than
claiming revision safety.

### Persistence lifecycle

Shared persistence owns this sequence:

1. ask the adapter to open one scoped storage lease
2. read and validate `workspace.json` and its opaque storage version
3. resolve and materialize the indexed current revision according to that revision's format
4. apply authored inputs and run the Workspace lifecycle
5. select the files allowed by the save policy
6. create a new archive or folder artifact using the provider's configured format
7. upload the complete new artifact under a fresh revision ID
8. build the next bounded Workspace index
9. conditionally publish `workspace.json` against the version read during acquisition
10. delete artifacts pruned from the committed index
11. release provider resources and the temporary materialization

Publication happens before pruning. A deletion failure may leave excess unreferenced history, but it must not make
the newly committed current revision unreadable. An upload that never reaches index publication is an orphan, not a
visible revision.

Normal retention uses the bounded revision list already stored in `workspace.json`; it does not list the backend to
discover current state:

```ts
type WorkspaceRetention = "current" | { revisions: number }
```

`"current"` retains one revision. `{ revisions: N }` retains the current revision and at most `N - 1` historical
revisions. Unlimited history is not part of the initial contract because it would grow the shared index without
bound.

Backend listing remains necessary for explicit repair and garbage collection of orphan uploads, temporary entries,
and manually altered storage. It is not part of ordinary current-revision selection.

### Provider construction and escape hatch

Built-in revision-backed providers should become thin configuration around the shared engine:

```ts
function s3Workspace(options: S3WorkspaceOptions): WorkspaceProvider {
  return createPersistentWorkspaceProvider({
    format: options.format,
    storage: s3WorkspaceStorage(options),
  })
}
```

S3 and filesystem revision stores use the same persistence engine with their own adapters. Direct in-place local
directories and genuinely attached provider-native volumes may implement `WorkspaceProvider` themselves because the
durable directory is already the live materialization and revision encoding would add a false copy boundary.

This escape hatch is intentional. Shared persistence is the standard way to build revision-backed providers, not a
lowest-common-denominator filesystem imposed on every Workspace implementation.

## Local provider

“Local” describes where the Workspace is materialized, not whether the application's source directory is modified.

Two modes are useful.

### Staged local mode

The implemented staged local provider is:

```ts
filesystemWorkspace({
  directory: "/var/lib/aml/workspaces",
  format: "folder",
  temporaryDirectory: "/var/tmp",
})
```

It:

- creates a unique directory beneath a configured safe root or the operating-system temporary directory
- restores local durable state into that directory when an identity already exists
- applies authored input entries there
- exposes only that materialization to descendant Sandboxes and trusted local Agents
- persists the selected revision into provider-owned storage
- removes the run materialization after release

The provider validates its storage paths and removes only its unique run materialization. Staged local state uses
shared revision persistence; omitted `format` uses archive.

### In-place local mode

In-place mode preserves the existing provider behavior:

```ts
localWorkspace({
  directory: "/work/repository",
})
```

It:

- acquires the existing physical directory directly
- uses the fixed renewable cross-process writer lock unless `lock={false}`
- makes writes durable immediately
- uses save as a health barrier
- makes no rollback, staging, or selective-persistence claim

An in-place provider cannot enforce rollback or selective saving: descendant writes are already durable whether AML
calls `save()` or not. Callers needing `load` or `save` isolation use `filesystemWorkspace()`.

Open decisions:

- whether the runtime supplies a default staged provider when `<Workspace>` omits `provider`
- whether the default input is empty or copies `AmlRuntimeOptions.cwd`

The safest initial default is an empty staged Workspace with explicit inputs. Copying the application cwd implicitly
is convenient but expensive and can expose credentials, build output, caches, and unrelated repositories.

## Remote and object-store providers

A remote durable provider using shared persistence still returns or coordinates one active materialization:

1. its storage adapter acquires the durable identity and writer authority
2. WorkspacePersistence reads `workspace.json` and resolves the current revision
3. WorkspacePersistence downloads and validates that revision into a unique temporary root
4. the resulting provider returns the materialization to AML
5. WorkspacePersistence receives the selected state after execution
6. it writes a new archive or folder revision through the adapter
7. it atomically updates `workspace.json`
8. it prunes unreferenced retained history and releases writer authority and temporary files

For Cloudflare, R2 stores `workspace.json`, the fixed-policy `lock.json`, and archive or folder revision artifacts.
The AML host or compatible Sandbox integration owns materialization transfer. No database or Durable Object is
required by the current provider.

The remote provider must defend against:

- archive path traversal and absolute entries
- symlink and hard-link escape
- decompression bombs and unbounded file counts
- partial uploads becoming visible as current
- partial folder prefixes becoming indexed as current
- lease expiry during upload
- stale writers publishing after a newer fencing token
- failed cleanup masking the evaluation or persistence failure

## Storage representation

Storage representation is an optional provider-construction choice. Omission selects archive:

```ts
s3Workspace({
  bucket,
  format: "archive",
})
```

`"archive"` stores one AML-created `tar.gz` per revision:

```text
<workspace-key>/
  workspace.json
  revisions/
    <revision-id>.tar.gz
```

Advantages:

- one or few object-store operations
- straightforward atomic publication through immutable revision keys
- efficient transfer for many small files
- can retain modes, empty directories, and symlinks under an explicit policy

Costs:

- a small change may rewrite the complete selected archive
- selective retrieval is difficult
- extraction requires careful validation
- archive tooling availability varies across runtimes

`"folder"` stores one isolated folder or prefix per revision:

```text
<workspace-key>/
  workspace.json
  revisions/
    <revision-id>/
      ...
```

Advantages:

- individual files are visible and transferable without rewriting one full archive
- mounted stores can use native directory operations
- future adapters may incrementally upload unchanged content

Costs:

- object stores require many requests and recursive listing
- empty directories, modes, links, deletions, and integrity need explicit portable rules
- publication still requires `workspace.json`; an object prefix is not an atomic directory
- cleanup requires recursive provider operations

Format is recorded on every revision. Switching the configured save format restores the indexed current revision
using its original format, then publishes the next revision using the new format. It never starts with an empty
Workspace merely because representation changed.

### Mounted durable filesystem

A provider-native volume or mount may avoid explicit upload and download as a distinct Workspace provider. It must
still satisfy AML's observable ordering, selection, deletion, and writer-ownership rules. If it cannot enforce
selected persistence, it must reject that policy or declare a distinct in-place capability. A mounted filesystem
used as a revision store can instead implement `WorkspaceStorageAdapter` and select `"archive"` or `"folder"`.

## Git

Git contains three separate concerns:

1. materializing a repository as an input
2. letting the Agent run ordinary Git commands
3. publishing work through commits, branches, pushes, or pull requests

None requires a first-class component initially. Repository materialization and ordinary Git commands can use an
explicit sandboxed Script when the selected environment contains Git:

```tsx
<Script command="git" args={["clone", repository, "repo"]} />
```

Automatic commit or push behavior should not be part of the core Workspace completion contract. It requires policy
for:

- credentials and secret delivery
- author and committer identity
- branch creation and naming
- dirty starting repositories
- commit message generation
- hooks and signing
- non-fast-forward updates
- remote conflicts and retries
- whether a failed Agent run may publish
- external effects that Workspace rollback cannot undo

A later Git component or higher-level workflow may own those decisions explicitly if Script proves insufficient.

Git worktrees are a useful local optimization, not a portable materialization format. A worktree's `.git` file often
references metadata outside the directory. Copying or archiving only the worktree can therefore produce a broken
remote checkout. A local Git-aware provider may use worktrees internally while exposing an ordinary logical
Workspace to AML.

## Authored command execution: `<Script>` (initial implementation complete)

`<Script>` is a useful candidate primitive for arbitrary setup and validation: cloning a repository, installing
dependencies, running tests, or preparing input for a later Agent. Its captured standard output could become the
component's text output and therefore feed a following Agent in normal AML evaluation order.

It is an execution primitive, not a Workspace storage or materialization primitive. With an active Sandbox it always
executes through that Sandbox's runtime. Without one it executes as a trusted host process from the AML runtime cwd.
Both forms may select a portable relative working directory:

```tsx
<Workspace id="review-42" provider={workspaceStore} cwd="repo">
  <Sandbox provider={sandbox}>
    <Script cwd="repo" command="git" args={["status", "--short"]} />
    <Agent>Review the repository.</Agent>
  </Sandbox>
</Workspace>
```

Argument-vector execution is the safer form for commands assembled from data. Script source uses an explicit
interpreter selected by the author:

```tsx
<Script shell="sh">{scriptText}</Script>
<Script shell="bash">{bashScript}</Script>
<Script shell="node">{javascriptSource}</Script>
```

On the host, `cwd` resolves from the AML runtime cwd. In a Sandbox it resolves from the active Sandbox root. Omitting
the prop uses the host runtime cwd or effective Sandbox cwd respectively. Absolute paths, backslashes, and parent
traversal are rejected. This working directory is process configuration, not a confinement boundary.

Each supported interpreter needs documented invocation semantics. Providers reject a missing executable; AML does
not install it or silently choose another interpreter. Interpolated AML text no longer preserves which bytes came
from trusted source code and which came from untrusted data, so choosing Script explicitly accepts execution of the
fully rendered child text.

AML's post-order evaluation also makes an Agent-authored script possible:

```tsx
<Sandbox provider={sandbox}>
  <Script shell="bash">
    <Agent>Write the requested setup script.</Agent>
  </Script>
</Sandbox>
```

This is intentionally powerful and dangerous. Unsandboxed Script has the AML host's authority and is appropriate only
for trusted authored automation. Generated Script needs an enforcing Sandbox plus explicit timeout, output limits,
exit-code semantics, cancellation, environment and credential policy, network policy, and trace redaction.
`<Script>` itself does not claim to make authored or generated code safe. Git commands can initially run through
Script without a first-class Git component.

## Concurrency and publication

Workspace locking defaults to enabled:

- one evaluation owns one durable Workspace identity through save and release
- another acquisition rejects with `WorkspaceConflictError`
- built-in renewable locks refresh every five minutes and become recoverable after twenty minutes without renewal
- timing is fixed and is not part of provider configuration
- `lock={false}` permits overlapping materializations
- unlocked revision-backed saves still use conditional `workspace.json` publication, so stale state cannot overwrite
  a committed revision

Direct mutable providers remain different. With `lock={false}`, their writes are immediately durable and follow the
ordinary concurrency behavior of the underlying filesystem.

Parallelism inside one active Workspace is controlled separately:

- `writeConcurrency="serial"` is the default
- writable root Sandboxes wait before acquisition and hydrate only after the prior writer reconciles
- read-only Sandboxes remain parallel
- multiple Agents inside one Sandbox remain parallel on the same live filesystem
- `writeConcurrency="parallel"` allows writable root Sandboxes to overlap; shared mounts behave like split terminals,
  while transferred snapshots can overwrite one another during reconciliation
- selected persistence happens only after all permitted attachments reconcile

Git branches do not replace Workspace writer coordination. Two writers can still modify the same materialized files,
provider metadata, or non-Git outputs.

## Failure and cancellation

The lifecycle must preserve independent failures:

- descendant evaluation failure
- Sandbox reconciliation failure
- persistence failure
- Workspace release failure
- caller cancellation

The original evaluation or cancellation remains causally visible when persistence or cleanup also fails.

Open policy decisions:

- whether persistence is attempted after cancellation
- whether a failed reconciliation permits saving the last known host materialization
- whether failed-run revisions are published by default
- whether a provider may retain a failed materialization for debugging

The current implementation saves after descendant failure. Preserving that behavior is useful for autonomous work,
but selected revision publication gives AML an opportunity to label or retain failed output without making it the
normal current revision. That alternative should be evaluated during the remote provider spike.

No initial provider promises crash-safe continuous checkpointing. A process or remote Sandbox failure may lose edits
that were not reconciled into the active materialization.

## Security boundaries

- A working directory is not a security boundary.
- Local staged execution protects the application checkout from accidental materialization and copy-back; it does not
  confine a trusted host process from accessing other host paths.
- Untrusted Agent commands and generated Script source require a Sandbox that enforces filesystem and process isolation.
- Every authored destination and persisted path must remain beneath the physical materialization root.
- Input sources should default to the application's configured source root and require explicit grants for external
  paths.
- Provider credentials and Agent credentials must never be written into the Workspace implicitly.
- Persistence applies an internal denylist for provider control files, transient credentials, and lock metadata.
- Archives are extracted only after validating entry paths and types.
- Symlink behavior is explicit for input, execution, and persistence; AML must not follow a Workspace symlink into a
  host secret during save.
- In-place local mode is explicitly unsafe for selective persistence and rollback.
- Git push, pull-request creation, and other external effects remain outside filesystem persistence guarantees.

## Observability

Workspace traces should separate:

- acquisition and lease identity
- restore/materialization
- authored input application
- Sandbox attachment and reconciliation
- persistence selection summary
- provider publication
- release and cleanup

Traces may include:

- provider name
- Workspace and lease identities
- logical cwd
- counts and total sizes of restored, authored, and persisted entries
- include and exclude pattern counts
- revision identity
- outcome and duration

Traces must not include:

- file contents by default
- credentials
- signed URLs
- object-store access tokens
- host paths that reveal unrelated filesystem layout unless diagnostic policy explicitly permits them

## Conformance expectations

Provider-neutral conformance should prove:

- acquisition returns one valid, contained materialization
- a conflicting writer rejects with `WorkspaceConflictError` when locking is enabled
- `lock={false}` allows overlapping revision-backed materializations without allowing stale publication
- release makes the identity acquirable again
- restore happens before authored inputs
- authored inputs are visible to descendant Agents
- logical cwd maps to the same logical directory locally and in a Sandbox
- serial writable Sandboxes observe prior reconciled changes
- parallel read-only Sandboxes do not wait for the writable-Sandbox permit
- selected additions and modifications persist
- selected deletions persist
- excluded paths do not enter the next revision
- persistence runs according to the configured outcome policy
- save and release are exactly once under success, failure, and cancellation
- malformed leases are cleaned without publishing
- provider errors propagate without being mistaken for conflicts

Local integration tests should additionally prove that staged mode never writes into its source checkout and cleans
only its unique materialization.

Remote integration tests should perform a full round trip:

1. seed an unpredictable input
2. materialize it into a remote or attached Sandbox
3. have a real Agent read it and write selected and excluded outputs
4. reconcile and publish the Workspace
5. acquire the same identity again
6. verify selected output, excluded output, and deletion behavior

## Delivery phases

Each phase is independently reviewable and should update `SPEC.md` only after its behavior and tests are accepted.

### Phase 0: Contract decisions and compatibility plan

Status: implemented for the persistence contract.

Accepted direction:

- omitted Workspace identities default to `crypto.randomUUID()`
- revision-backed providers use `createPersistentWorkspaceProvider()` and `WorkspaceStorageAdapter`
- persistence format is closed to `"archive" | "folder"` and defaults to archive
- archive always means AML-owned `tar.gz`; providers never supply codecs
- `workspace.json` records current state and bounded retained history with format stored per revision
- storage adapters own scoped access, byte transport, listing, deletion, and atomic metadata publication
- omitted `load` restores current; omitted `save` saves nothing
- `save: true` uses `.gitignore`, publishes on success, and retains one revision
- explicit include overrides `.gitignore`; exclude always wins
- symlinks reject
- adapters return one acquired storage lease with streaming bodies and opaque version tokens
- prototype base64 Workspace keys and `current.json` pointers are legacy state; the accepted providers do not
  silently migrate or merge them

Still decide:

- whether the runtime supplies a default staged provider and initial input source

Deliverables:

- accepted normative contract edits
- public `WorkspaceStorageAdapter` and `createPersistentWorkspaceProvider()` contract
- accepted `workspace.json` schema and migration behavior
- validated file-manifest contract owned by WorkspacePersistence
- deterministic lifecycle test plan

No runtime behavior changes in this phase.

### Phase 1: Logical cwd

Status: implemented for Workspace materialization references and descendant Sandbox acquisition.

Add one portable cwd to the active Workspace:

- validate a relative `cwd`
- default it to `.`
- carry it through materialization and Sandbox attachment
- start descendant Sandbox commands and Agents at the corresponding effective directory
- reject missing, non-directory, and escaping cwd values

Proof:

- deterministic and real local Sandbox execution observe the Workspace cwd
- no host materialization path leaks into the Agent contract

This phase does not add input descriptors or selective persistence.

### Phase 2: Safe staged local Workspace

Status: implemented as `filesystemWorkspace()`; `localWorkspace()` remains explicitly in-place.

Add a staged local provider or staged mode:

- create one unique safe materialization
- retain the existing in-place behavior as an explicit mode
- keep writer coordination
- restore and clean local durable state
- reject selective-save claims in in-place mode

Proof:

- an Agent can modify the staged Workspace without modifying the source directory
- cleanup removes only the unique run materialization
- concurrent acquisition retains the existing conflict behavior

### Phase 3: `<File>` preparation

Status: implemented, including local `src`, nearest-filesystem selection, and guest-side writes.

Add text file inputs:

- inline text
- replacement mode
- safe parent creation
- authored-order visibility
- post-order generated content
- mutually exclusive application-owned local `src`
- nearest-filesystem selection
- guest-side writes through portable Sandbox file operations

Proof:

- a File is visible to the following Agent
- an Agent-generated File is visible to a later Agent
- traversal and symlink escape reject
- `<File>` without Workspace or Sandbox rejects
- a File inside Sandbox changes the live guest rather than a stale host replica

Append/create modes, authored binary data, and directory copying remain out until separately accepted.

### Phase 4: Include and Agent staging

Status: implemented for 0.8.

Add the narrow active-filesystem and per-Agent staging owners:

- expose portable Sandbox stat, complete-file read, and atomic replacement write operations
- add Include `src` and nearest-filesystem `path` modes
- stage oversized application-owned Includes at AML-generated Agent-visible paths
- redefine Skill as a validated complete local package
- materialize `.agents/skills/<name>/` and map native provider discovery
- add metadata-only discovery fallback without inlining the Skill body
- clean invocation-owned staging without deleting Workspace-owned files

Proof:

- Include observes live guest changes and enforces byte limits
- an oversized local Include is readable at the path named in its prompt
- compatible Agents discover complete Skill packages including supporting resources
- unsupported providers receive only fallback metadata and can read the canonical Skill path
- cancellation and failure clean ephemeral staging

### Phase 5: Shared Workspace persistence and selection

Status: implemented for both formats and both current storage adapters.

Implement `WorkspacePersistence` and `createPersistentWorkspaceProvider()`:

- optional `"archive" | "folder"` configuration defaulting to archive
- versioned `workspace.json` parsing and atomic publication
- current revision restoration across per-revision formats
- `crypto.randomUUID()` default Workspace and revision identities
- include and exclude patterns
- outcome policy
- safe materialization walk
- selected additions, modifications, and deletions
- AML-owned tar/gzip creation and validated extraction
- positive integer total-revision retention on `<Workspace save={{ retention }}>`
- publication-before-pruning failure semantics
- persistence summaries in traces

Proof:

- reacquisition restores exactly the selected revision
- excluded files and external symlink targets never persist
- success, failure, cancellation, and release interactions follow the accepted contract
- format changes restore the old current revision before publishing the new representation
- malformed or unknown `workspace.json` never becomes a fresh empty Workspace
- retention preserves current state and removes only revisions excluded from the newly committed index
- adapter test doubles prove conditional index publication, orphan handling, and release causality

### Phase 6: S3 adapter extraction and live archive proof

Status: implemented behind shared persistence for archive and folder. MinIO integration remains opt-in; the
credentialed R2 smoke is the sparse live proof.

Refactor the existing S3 provider into a thin `WorkspaceStorageAdapter`:

- use a fixed renewable run lock by default and conditional writes for index publication
- allow `lock={false}` without weakening conditional publication
- map S3 reads, streaming writes, listing, deletion, and conditional metadata publication into the public adapter
- move archive creation, extraction, limits, Workspace index, revision selection, and retention into
  WorkspacePersistence
- leave prototype `current.json` and base64-keyed objects untouched as unsupported legacy state
- retain exact cleanup and error causality

Proof:

- accepted `workspace.json` revisions restore in their recorded archive or folder format
- credentialed Docker-to-Daytona-to-R2 reacquisition round trip through the shared persistence engine
- concurrent writer rejection
- stale writer cannot publish
- selected deletion, retention, and failure behavior
- S3 adapter conformance contains no archive or glob implementation

### Phase 7: Host and sandboxed `<Script>`

Status: initial implementation complete.

Add authored execution through the host or active Sandbox runtime:

- use the trusted local process transport when no Sandbox is active
- support explicit `sh`, `bash`, and `node` interpreters
- retain literal executable and argument-vector execution for data-driven commands
- default to the runtime cwd on the host and the effective Sandbox cwd inside a Sandbox
- support a portable relative `cwd` from the host runtime cwd or active Sandbox root
- bound runtime, standard output, and standard error
- define non-zero exit, cancellation, and trace-redaction behavior
- allow resolved child text, including Agent output, to become Script source
- never fall back from an active Sandbox to host execution

Proof:

- Script changes are visible to later Agents in the same Sandbox
- Script output can feed a later Agent
- Script outside Sandbox executes on the host from the runtime cwd
- Script-local cwd resolves against the correct host or Sandbox base
- a missing interpreter rejects without fallback
- Script inside a Sandbox runs only through the selected Sandbox provider

### Phase 8: Folder persistence and second storage adapter

Status: implemented for S3-compatible object storage and the local filesystem adapter.

Implement the second format and prove that shared persistence is not S3-specific:

- one isolated revision directory or object prefix
- complete upload before index publication
- portable file enumeration and reconstruction
- deletion, empty-directory, mode, and symlink rules
- migration from an archive current revision to a newly saved folder revision
- one mounted-filesystem `WorkspaceStorageAdapter`

Proof:

- the same WorkspacePersistence conformance suite passes for archive and folder
- switching either direction does not initialize empty state
- interrupted folder writes remain unreferenced
- retention deletes complete folder revisions without touching current state
- the second adapter contains no selection, retention, index-schema, or archive logic

### Phase 9: Additional Workspace transports

Only after measuring the archive transfer path, evaluate materially different storage paths:

- volume mounts coordinated with the Sandbox provider
- network mounts such as SMB or NFS
- SFTP synchronization
- Google Drive synchronization

Mounted storage must preserve the same authored overlays, access policy, persistence selection, deletion behavior,
and writer coordination. Synchronized providers should reuse `WorkspacePersistence` when their storage operations can
honor its publication contract.

Proof:

- mounted providers avoid unnecessary coordinator round trips
- synchronized providers restore and publish through the shared conformance suite
- the observable Workspace behavior matches staged local and S3 archive providers

### Phase 10: Git-aware workflows, only if Script proves insufficient

Evaluate separately, based on demonstrated demand:

- repository input beyond a sandboxed clone Script
- local worktree optimization
- branch creation
- checkpoint commits
- final commits
- pushes and pull requests

This phase requires a distinct external-effects contract and must not silently extend ordinary Workspace save.

## Remaining questions

1. Does `<Workspace>` without `provider` create a staged local Workspace automatically?
2. Is an omitted input set empty, or does it mean “stage the runtime cwd”?

## External design references

- [OpenAI Agents SDK: Sandbox Agents concepts](https://openai.github.io/openai-agents-js/guides/sandbox-agents/concepts/)
- [Flue: Sandboxes](https://flueframework.com/docs/guide/sandboxes/)
- [Flue: Durable Agents](https://flueframework.com/docs/concepts/durable-execution/)
- [Daytona: Persistence](https://www.daytona.io/docs/en/persistence/)
- [E2B: Sandbox snapshots](https://e2b.dev/docs/sandbox/snapshots)
- [Modal: Sandbox filesystem access](https://modal.com/docs/guide/sandbox-files)
- [Cloudflare R2: Objects and prefixes](https://developers.cloudflare.com/r2/objects/)
- [Cloudflare Sandbox SDK: Mount buckets](https://developers.cloudflare.com/sandbox/guides/mount-buckets/)
- [Cloudflare Sandbox SDK: HTTP API workspace persistence](https://developers.cloudflare.com/sandbox/bridge/http-api/)
- [Cloudflare Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
