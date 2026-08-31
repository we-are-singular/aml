---
title: CLI changelog
description: Human-readable release history for @aml-jsx/cli.
tableOfContents:
  minHeadingLevel: 2
  maxHeadingLevel: 2
---

This page tracks `@aml-jsx/cli`. Entries are newest first. See [GitHub Releases](https://github.com/we-are-singular/aml/releases) for tags and complete release artifacts.

<!-- changelog:entries -->

## CLI v0.3.3 — Version-only release — no user-facing changes

Released 2026-08-31.

This CLI release contains no new code commits. The working tree bumps `@aml-jsx/cli` to 0.3.3 with no underlying behavioral change, and the release inventory between the prior `cli-v0.3.2` tag and HEAD contains no CLI-scoped commits. There is nothing new for readers to adopt in this entry.

### Highlights

- **No new CLI behavior in this release.** The commit range from `cli-v0.3.2` to HEAD includes only SDK, sandbox, docs, and root-level changes; none touch the CLI. The package version bump to 0.3.3 carries no user-facing addition, fix, or configuration change — the current CLI capabilities are already captured in the prior entry. [CLI reference](/docs/cli)

## CLI v0.3.2 — Version-only release — no user-facing changes

Released 2026-08-29.

This CLI release contains no new code commits. The working tree bumps `@aml-jsx/cli` to 0.3.2 with no underlying behavioral change, and the release inventory between the prior `cli-v0.3.1` tag and HEAD contains no CLI-scoped commits. There is nothing new for readers to adopt in this entry.

### Highlights

- **No new CLI behavior in this release.** The commit range from `cli-v0.3.1` to HEAD includes only SDK, sandbox, docs, and root-level changes; none touch the CLI. The package version bump to 0.3.2 carries no user-facing addition, fix, or configuration change. The prior entry (CLI v0.3.1) already documents the current CLI capabilities. [CLI reference](/docs/cli)

## CLI v0.3.1 — SDK 0.6 compatibility

Released 2026-08-18.

The CLI's declared SDK compatibility range moves from ^0.5.0 to ^0.6.0, aligning the package with the freshly released `@aml-jsx/sdk` 0.6 line.

### Highlights

- **Aligned SDK compatibility range.** The CLI's dev and peer dependency range for `@aml-jsx/sdk` moved from ^0.5.0 to ^0.6.0, matching the SDK line the CLI is developed and reviewed against, so consumers pairing the CLI with SDK ^0.6.0 now satisfy the peer requirement. Covers: support sdk 0.6 (49348c3). [CLI reference](/docs/cli/#run-the-package)

### Commits

- fix(cli): support sdk 0.6 (49348c3)

## CLI v0.3.0 — Test infrastructure hardening

Released 2026-08-16.

This release makes no user-facing behavior changes. It only adjusts the CLI's test configuration so automated integration checks remain reliable on cold CI runners, where per-spawn Node startup can otherwise exceed Vitest's default timeout before the page cache warms up.

### Highlights

- **More resilient integration tests.** A new vitest.config.ts raises Vitest's per-test timeout from the 5s default to 30s for CLI integration tests. These tests spawn the compiled binary via spawnSync, and each child process on a cold runner pays several seconds of Node startup that previously could flake against the shorter default. No runtime or CLI behavior is affected.

### Commits

- test(cli): raise integration test timeout for cold ci runners (ebabf7a)

## CLI v0.2.1 — Independent SDK releases with an aligned compatibility range

Released 2026-08-13.

The CLI is no longer coupled to in-development SDK releases. Package validation no longer forces the CLI's SDK dev and peer ranges to match the workspace SDK version, and the declared compatibility range now targets `@aml-jsx/sdk` ^0.5.0, so the CLI and SDK can publish independently.

### Highlights

- **Independent SDK and CLI releases.** The CLI and SDK can now release on their own schedules. Release validation no longer requires the CLI's SDK dev and peer ranges to equal the workspace SDK's in-development version; instead the packed tarball is installed into an empty consumer to verify the declared SDK peer range. Covers: allow independent sdk releases (220c85e), derive sdk package range (26cc5a6). [CLI reference](/docs/cli/#run-the-package)
- **Aligned SDK compatibility range.** The CLI's dev and peer dependency range for `@aml-jsx/sdk` moved from ^0.4.1 to ^0.5.0, matching the SDK line the CLI is developed and reviewed against, so consumers pairing the CLI with SDK ^0.5.0 now satisfy the peer requirement. Covers: align sdk compatibility range (d0b8897). [CLI reference](/docs/cli/#run-the-package)

### Commits

- fix(cli): allow independent sdk releases (220c85e)
- fix(cli): derive sdk package range (26cc5a6)
- fix(cli): align sdk compatibility range (d0b8897)
- test(cli): cover script working directory (384660e)
- test(cli): allow named export startup time (0c1c3f9)
- test(cli): split export integration cases (8d1c36a)

## CLI v0.2.0 — Graceful cancellation of interrupted runs

Released 2026-08-12.

`aml run` now turns `SIGINT` (Ctrl+C) and `SIGTERM` into cancellation of the active evaluation, closing Agent sessions and releasing Sandbox leases before the CLI exits, instead of terminating abruptly.

### Highlights

- **Graceful run cancellation.** Pressing Ctrl+C (or sending `SIGTERM`) aborts the running workflow and clears its `AbortSignal`, propagating cancellation to Agent sessions, ACP requests, MCP relays, and Sandbox operations. AML closes active sessions and invokes each acquired lease's `release()` boundary so local and remote provider resources are cleaned up before the process exits. [CLI reference](/docs/cli/#interrupting-a-run) · [Providers](/docs/reference/providers) · [Operations](/docs/production/operations)
- **Predictable signal exit codes.** The first interrupt starts a graceful shutdown with up to 10 seconds for provider cleanup, then exits with the conventional status — `130` for `SIGINT`, `143` for `SIGTERM`. A second interrupt (or a cleanup that outlives the deadline) forces immediate termination with the same status. [CLI reference](/docs/cli/#interrupting-a-run)
- **Cancellation-aware provider cleanup.** The evaluation `AbortSignal` now flows into acquisition and runtime Sandbox operations, and release is memoized so success, failure, and cancellation converge on one idempotent provider call. Persistent shared providers terminate evaluation-owned executions without destroying infrastructure meant to outlive the run. [Providers](/docs/reference/providers) · [Operations](/docs/production/operations) · [Incident response](/docs/production/incident-response)

### Commits

- test(cli): scope signal tests to supported platforms (a0060a9)
- fix(cli): gracefully cancel interrupted runs (8879658)
- release(cli): v0.1.4 (86e08d2)

## CLI v0.1.4 — Graceful cancellation of interrupted runs

Released 2026-08-12.

`aml run` now turns `SIGINT` (Ctrl+C) and `SIGTERM` into cancellation of the active evaluation, closing Agent sessions and releasing Sandbox leases before exiting, instead of terminating abruptly.

### Highlights

- **Graceful run cancellation.** Pressing Ctrl+C (or sending `SIGTERM`) aborts the running workflow and clears its `AbortSignal`, propagating cancellation to Agent sessions, ACP requests, MCP relays, and Sandbox operations. AML closes active sessions and invokes each acquired lease's `release()` boundary so local and remote provider resources are cleaned up before the process exits. [CLI reference](/docs/cli/#interrupting-a-run) · [Providers](/docs/reference/providers) · [Operations](/docs/production/operations)
- **Predictable signal exit codes.** The first interrupt starts a graceful shutdown with up to 10 seconds for provider cleanup, then exits with the conventional status — `130` for `SIGINT`, `143` for `SIGTERM`. A second interrupt (or a cleanup that outlives the deadline) forces immediate termination with the same status. [CLI reference](/docs/cli/#interrupting-a-run)
- **Cancellation-aware provider cleanup.** The evaluation `AbortSignal` now flows into acquisition and runtime Sandbox operations, and release is memoized so success, failure, and cancellation converge on one idempotent provider call. Persistent shared providers terminate evaluation-owned executions without destroying infrastructure meant to outlive the run. [Providers](/docs/reference/providers) · [Operations](/docs/production/operations) · [Incident response](/docs/production/incident-response)

### Commits

- test(cli): scope signal tests to supported platforms (a0060a9)
- fix(cli): gracefully cancel interrupted runs (8879658)
- release(cli): v0.1.4 (86e08d2)

## CLI v0.1.3 — CLI v0.1.3 – Richer error diagnostics and Windows portability

Released 2026-08-11.

Prints the full provider error cause chain on failure, fixes Windows compatibility for the packed CLI, and automates changelog generation during releases.

### Highlights

- **Full error cause chain in CLI output** When an Agent run fails, the CLI now walks the <code>Error.cause</code> chain and prints each link separated by <code>caused by:</code>, revealing the actual provider diagnostic that was previously hidden behind a generic wrapper message. [CLI reference](/docs/cli) · [Error handling](/docs/errors) · [Changelog](/docs/reference/changelog/cli)
- **Windows portability fixes** Two changes make the packed CLI installable and testable on Windows: the workflow-loader no longer executes Vite's client-only <code>/@vite/env</code> bootstrap (which resolves as a filesystem module in packed builds), and the package-check script skips POSIX executable-bit validation on <code>win32</code> since npm installs a <code>.cmd</code> shim instead of a raw binary. [Compatibility](/docs/compatibility) · [CLI reference](/docs/cli)
- **Auto-generated changelog on release** The <code>release-it</code> <code>after:bump</code> hook now runs <code>changelog:cli</code>, formats the generated page, and stages it alongside the package-lock bump so every future CLI release includes an up-to-date changelog entry without manual editing. [CLI changelog](/docs/reference/changelog/cli)
- **Dedicated CI portability workflow** Node and OS portability checks were extracted from the website workflow into <code>.github/workflows/cli-portability.yml</code>, keeping CI concerns separated and the website deploy pipeline lightweight. [Operations](/docs/production/operations)

### Commits

- fix(cli): print provider failure causes (e6010fd)
- fix(cli): format generated changelog entries (264974c)
- feat(cli): maintain changelog during releases (732c409)
- fix(cli): avoid windows vite env bootstrap (5c675b0)
- ci(cli): scope portability checks (d850329)
- fix(cli): make package check portable on windows (6d15564)

## CLI v0.1.2 — Version-aware integration checks

Released 2026-08-10.

CLI integration checks now follow the package version instead of embedding stale release expectations, and the package participates in AML's independent release lanes.

### Highlights

- **Portable version checks.** Clean package verification reads the current CLI version directly from package metadata. [CLI reference](/docs/cli/)
- **Independent publishing.** CLI releases now use `cli-v*` tags and package-scoped generated notes.

### Commits

- release(cli): v0.1.2 (554e164)
- fix(cli): follow package version in integration tests (5230cb9)

## CLI v0.1.1 — Direct AML workflow execution

Released 2026-08-10.

The first CLI release made trusted TypeScript, TSX, and JavaScript AML workflow files directly executable without a separate application entrypoint.

### Highlights

- **Source-first execution.** `aml run` evaluates workflow modules through Vite and `vite-node` without requiring a bundle step. [CLI reference](/docs/cli/)
- **Operational output.** Workflow results stay on stdout while lifecycle and trace diagnostics use stderr.
- **Environment loading.** Workflow-local Vite environment files and explicit runtime overrides are applied before module evaluation.

### Commits

- release(cli): v0.1.1 (1060b43)
