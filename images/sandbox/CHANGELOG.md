# Changelog

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
