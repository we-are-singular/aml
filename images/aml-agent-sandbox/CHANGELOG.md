# Changelog

## Unreleased

- Embed the published AML CLI and SDK packages with bare-import resolution that remains visible behind mounted
  Workspaces.
- Smoke deterministic AML execution from clean writable and read-only Workspace mounts without local dependencies.

## 0.1.0

- Establish a Debian Bookworm/glibc runtime with Node.js 26, npm, Python 3, Git, and common Agent shell/network utilities.
- Remove duplicated OpenCode payloads and Pi's unused optional interactive assets from the headless ACP runtime.
- Run as the unprivileged `aml` user with writable runtime and Workspace directories.
- Pin the Codex, GitHub Copilot, GLM, OpenCode, Pi, and ACP executable versions used by AML's smoke matrix.
- Add local non-root conformance checks and package/version verification.
- Validate all five AML Agent providers through the Docker Sandbox and Workspace contract.
