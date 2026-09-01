# Changelog

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
