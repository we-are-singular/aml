# Changelog

## Next release

Node.js and OpenCode security runtime updates.

Sandbox images include Node.js 26.12.1, OpenCode 1.19.4, patched Hono, and updates to npm, Copilot, and Pi's MCP adapter.

- **Patched Node.js runtime.** Every variant uses Node.js 26.12.1. The [October 21 security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) fixes the Brotli decoder remote-code-execution vulnerability (CVE-2026-111497), TLS hostname-verification bypasses (CVE-2026-105483, CVE-2026-106069), and DNS name truncation at NUL characters (CVE-2026-105482).
- **Patched Hono.** Hono 4.13.13 fixes a static-file path decoding issue that could bypass middleware checks (CVE-2026-111757).
- **Patched OpenCode runtime.** OpenCode moves from 1.19.0 to 1.19.4 in the full and OpenCode variants. Its bundled Bun runtime advances to 1.4.4 with security fixes for Brotli, TLS, HTTP, WebSocket, and `fetch`, plus refreshed root certificates. See the [OpenCode 1.19.4 release notes](https://github.com/anomalyco/opencode/releases/tag/v1.19.4).
- **Updated supporting tools.** Every variant uses npm 12.2.1 with its bundled `ip-address` patched to 10.7.4, fixing CVE-2026-111997. The full and Copilot variants use Copilot 1.0.103, and the full and Pi variants use Pi MCP Adapter 5.3.2.

### Commits

- `build(root): update node 26 runtime to 26.12.1`
- `fix(root): update hono for ghsa-5r4p-p66f-jhc7`
- `test(sandbox): assert the image node version`

## 0.6.2

Embedded SDK 0.9.1.

The Sandbox image now embeds AML SDK 0.9.1 in place of 0.9.0. Image-hosted OpenCode workflows keep their native permission configuration while AML denials remain authoritative, and staged Includes and Skill packages stay readable when native external-directory access is denied. The image's installed Agent runtimes, image contract, and documented workflows are otherwise unchanged.

- **OpenCode native permissions are preserved.** The embedded SDK folds top-level and `agent.aml` `tools` and `permission` settings into OpenCode's permission rules, including scalar permission strings, granular rules, `external_directory` maps, and the legacy `write`/`patch` aliases. Other native `agent.aml` fields are retained and OpenCode's coding prompt stays intact, while AML's portable denials are applied last under OpenCode's last-rule-wins behavior. Empty native `tools` maps prevent a wildcard or alias from overriding an AML `edit` denial. See [OpenCode Agent](/docs/providers/agents/opencode/).
- **Staged Includes and Skills remain readable under external deny.** Staged inputs are associated with their `AgentRequest` through a non-enumerable `Symbol.for` registry, adding no public `AgentRequest` field. The OpenCode provider uses that association to allow only the invocation-private directory holding each staged `<Include />` and each staged `<Skill />` package when `permission.external_directory` is `deny`. Unrelated paths remain denied, including files outside a staged Skill package, while JavaScript Tools and structured output continue to work in the same run. See [Include reference](/docs/reference/primitives/include/) and [Skill reference](/docs/reference/primitives/skill/).
- **Release scope and history.** The embedded SDK release also adds CI coverage for the real OpenCode permission path against the pinned binary. This entry contains no other dependency changes, so the image's installed Agent runtimes and image contract remain unchanged. See [SDK changelog](/docs/reference/changelog/sdk/) and [Sandbox images](/docs/sandbox-images/).

### Commits

- `build(sandbox): embed sdk 0.9.1` (2ffd83f)

## 0.6.1

Embedded AML SDK 0.9.0.

The Sandbox image now embeds AML SDK 0.9.0, replacing 0.8.1. Image-hosted workflows gain the built-in Claude Agent provider, ACP failure diagnostics that survive to the caller, structured-output repair that runs only after a normal completion, and per-prompt usage in run summaries. The image's installed Agent runtimes, image contract, and documented workflows are unchanged.

- **Claude Agent provider available to image-hosted workflows.** The embedded SDK exports the built-in `claudeAgent()` provider, so workflows inside the image can launch the maintained `claude-agent-acp` adapter through the shared ACP lifecycle alongside Codex, Copilot, GLM, OpenCode, and Pi; the image already installs `@agentclientprotocol/claude-agent-acp` 0.91.0. SDK 0.9.0 also adds `AcpAgentLaunch.sessionMeta`, letting custom ACP profiles forward vendor-defined `_meta` unchanged with `session/new`. See [Claude Agent](/docs/providers/agents/claude/), [Provider authoring](/docs/reference/provider-authoring/), and [Compatibility](/docs/compatibility/).
- **ACP failures now preserve received output.** The exported `AcpAgentError` retains the ACP `sessionId` and every prompt attempt in execution order, including text and messages received before a failure and the `stopReason` once a prompt completed, while the original protocol or submission error stays as its cause. The structured-output repair prompt now runs only after a normal `end_turn`, so refusal, cancellation, and exhausted limits never trigger another prompt, and mismatched session-configuration values list the advertised values. See [Error handling](/docs/errors/), [Observability](/docs/observability/), and [Runtime reference](/docs/reference/runtime/).
- **Usage from every completed ACP prompt.** Run summaries produced inside the image preserve each completed ACP prompt's provider usage exactly once, including a structured-output repair prompt, and keep completed samples even when a later repair fails or is cancelled. Providers without prompt usage fall back to the turn's usage attribute, and missing usage adds no entry. See [Observability](/docs/observability/).
- **Refreshed SDK dependency baselines.** Embedding SDK 0.9.0 also advances the clients bundled inside the image: ACP SDK 1.3.0 to 1.8.0, MCP SDK to 1.32.1, AWS S3 client to 3.1152.0, Daytona to 0.224.1, Modal to 0.11.0, and OpenCode SDK to 1.19.0, plus routine library bumps for execa, globby, hookable, p-limit, typebox, and yaml. See [Sandbox images](/docs/sandbox-images/) and [SDK changelog](/docs/reference/changelog/sdk/).

### Commits

- `build(sandbox): embed sdk 0.9.0` (5e0dadb)

## 0.6.0

Base image refresh and release-tooling dependency patch.

The Sandbox image is rebuilt on a freshly pinned Debian Bookworm runtime base and pins its release toolchain's transitive basic-ftp client to a patched version. Neither change alters the embedded Agent runtimes, image behavior, or documented workflows.

- **Refreshed Debian Bookworm runtime base.** The sandbox Dockerfile pins its runtime stage to a newer `debian:bookworm-slim` digest, moving it off the previous pin. Because every variant image (`full`, `codex`, `copilot`, `glm`, `opencode`, and `pi`) builds from that stage, each is rebuilt on the current base packages. The Node.js build stage and the installed Agent/tooling versions are untouched, so existing deployments see no runtime or interface change.
- **Patched transitive `basic-ftp` in the release toolchain.** The image package now declares an npm `overrides` entry pinning the transitive `basic-ftp` FTP client to patched 6.2.3, replacing the 5.3.1 resolved through `get-uri` and the proxy-agent chain. That dependency belongs to the image's dev/release tooling and is excluded from the published image (`npm ci --omit=dev`), so the shipped runtime is unchanged while the stale transitive client is patched for builds and releases.

### Commits

- `fix(sandbox): override basic-ftp to patched 6.2.3` (0595c98)
- `build(sandbox): refresh debian bookworm base image` (e63f4b5)

## 0.5.2

OpenCode runtime bump and patched transitive locks.

The Sandbox image upgrades its embedded OpenCode runtime from 1.18.18 to 1.18.30 and advances a patched transitive hono dependency in its locked dependency tree. The bump carries the OpenCode fix line forward across the full and opencode variants as well as the repository's pinned integration baseline and related docs, while the lock change needs no direct dependency or behavioral adjustment.

- **OpenCode 1.18.18 → 1.18.30.** The full and opencode image variants now embed `opencode-ai` 1.18.30. The repository's pinned OpenCode integration baseline is bumped to match, and the getting-started guide, the OpenCode provider page, and the image variant table are updated so the documented executable version matches what ships in the image.
- **Patched transitive hono lock.** The sandbox image's lockfile advances the transitive hono HTTP library 4.13.2 → 4.13.7 to pull in upstream patches, with no direct dependency or behavioral change required.

### Commits

- `build(sandbox): upgrade opencode to 1.18.30` (9c3b28e)
- `build(sandbox): update patched hono lock` (facfe37)

## 0.5.1

Dependency security fixes.

- **Patch vulnerable transitive dependencies.** The sandbox image's locked dependency tree now uses patched versions of the vulnerable transitive utilities `fast-uri` and `qs`, so no direct dependency, API, or behavioral change is required. `fast-uri` advances 3.1.5 → 3.1.7 and `qs` advances 6.15.3 → 6.16.0, both address/query-string utilities pulled in through the runtime's HTTP stack, closing known security holes in the bundled transitive tree while existing workflows run unchanged.

### Commits

- `fix(sandbox): update vulnerable transitive dependencies` (b468b46)

## 0.5.0

Sandbox release pipeline polish.

- **Releases now publish their own overview and changelog.** Each release pushes `DOCKERHUB.md` as the Docker Hub repository overview through Docker Hub's metadata API, using a read/write personal access token from the caller's normal Docker configuration that is kept separate from the temporary browser login used for image publication. The token is verified before building and the pushed overview is confirmed afterward; `npm run sync:description --prefix images/sandbox` resynchronizes just the overview. The release-it `after:bump` hook also drafts and writes the sandbox changelog entry straight into `images/sandbox/CHANGELOG.md`.
- **Keyless signing is gated and safely awaited.** Keyless Cosign signing now waits for the maintainer to press Enter before each signature, so device-flow links are not opened until you are ready. Publication pauses once before the signing batch and Cosign's normal browser flow is restored so logins return through the local callback, with a Windows URL-handler shim under WSL to avoid File Explorer windows.
- **Signing can resume without rebuilding.** If signing fails after every image and smoke completed, `npm run release:sandbox -- --recover-signing` resumes from the already-pushed digests without rebuilding or rerunning smoke, and accepts the matching release tag anywhere in current `main` history.

### Commits

- `feat(sandbox): sync Docker Hub overview` (02b39dc)
- `feat(sandbox): automate release changelogs` (3fb9674)
- `fix(sandbox): restore browser signing flow` (5619a72)
- `fix(sandbox): await signing confirmation safely` (cbb51ee)
- `fix(sandbox): gate keyless image signing` (41d9f8a)

## 0.4.1

- Publish `full`, `codex`, `copilot`, `glm`, `opencode`, and `pi` images from one Dockerfile. Versioned and moving tags keep the existing unqualified image as the full variant while allowing deployments to select a smaller single-Agent runtime.
- Keep Node.js and npm, Python and pip, Git, jq, AML, and the selected Agent runtime in every variant while removing general-purpose build and diagnostic packages that Agents do not require by default.
- Build and check every variant independently, run each Agent's live smoke against its pushed digest, sign every digest, and move stable aliases only after the complete matrix succeeds.
- Retain `ghcr.io/we-are-singular/aml-agent-sandbox:dev` as the mutable, unpruned full image built from `main`. This is the first completed variant release after the interrupted 0.4.0 publication.

## 0.3.0

- Update the embedded AML runtime to CLI 0.3.2 and SDK 0.7.0.
- Bring per-Agent execution timeouts, structured-output recovery and nesting, callable JavaScript tools, explicit parallel boundaries, and application observability into image-hosted AML workflows through the updated SDK.

## 0.2.0

- Embed AML CLI 0.3.1 and SDK 0.6.0 with bare-import resolution that remains visible behind mounted Workspaces.
- Smoke deterministic AML execution from a clean Workspace without local dependencies.
- Publish stable Docker Hub images as the version and `latest`, while GHCR `dev` tracks pushes to `main`.
- Rename the source and GitHub release lane to Sandbox while retaining the `aml-agent-sandbox` image name.

## 0.1.0

- Establish a Debian Bookworm/glibc runtime with Node.js 26, npm, Python 3, Git, and common Agent shell/network utilities.
- Remove duplicated OpenCode payloads and Pi's unused optional interactive assets from the headless ACP runtime.
- Run as the unprivileged `aml` user with writable runtime and Workspace directories.
- Pin the Codex, GitHub Copilot, GLM, OpenCode, Pi, and ACP executable versions used by AML's smoke matrix.
- Add local non-root conformance checks and package/version verification.
- Validate all five AML Agent providers through the Docker Sandbox and Workspace contract.
