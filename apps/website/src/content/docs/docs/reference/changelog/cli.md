---
title: CLI changelog
description: Human-readable release history for @aml-jsx/cli.
tableOfContents:
  minHeadingLevel: 2
  maxHeadingLevel: 2
---

This page tracks `@aml-jsx/cli`. Entries are newest first. See [GitHub Releases](https://github.com/we-are-singular/aml/releases) for tags and complete release artifacts.

<!-- changelog:entries -->

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
