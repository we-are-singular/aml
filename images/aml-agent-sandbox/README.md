# AML Agent Sandbox

AML Agent Sandbox is a ready-to-use Debian image for running AI agents with AML. Codex, GitHub Copilot, GLM, OpenCode, Pi, Node.js, Python, Git, and common command-line tools are already installed.

Pull stable releases from Docker Hub:

```sh
docker pull wearesingular/aml-agent-sandbox:0.1.0
```

Docker Hub is the canonical release registry for semantic versions and `latest`. The public, mutable development image
built from the latest relevant `main` revision is available separately on GHCR:

```sh
docker pull ghcr.io/we-are-singular/aml-agent-sandbox:dev
```

GitHub Actions replaces this nightly/edge channel after relevant image changes land on `main`. It is not a mirror of a
Docker Hub release, and its contents and digest can change without a release.

## Included runtime

- Debian Bookworm with glibc
- Node.js 26 and npm
- Python 3 with pip, venv, and `python`/`python3` commands
- Git and CA certificates
- Bash, curl, jq, ripgrep, fd, file, patch, and process inspection tools
- SSH, DNS/IP diagnostics, netcat, SQLite, and common archive tools
- non-root `aml` user with writable home, `/tmp`, and `/workspace`
- no embedded credentials, Agent state, project dependencies, cloud CLIs, Docker daemon, browsers, compilers, or additional language runtimes

| Command          | Package                           |   Version |
| ---------------- | --------------------------------- | --------: |
| `codex-acp`      | `@agentclientprotocol/codex-acp`  |   `1.4.0` |
| `codex`          | `@openai/codex`                   | `0.147.0` |
| `copilot`        | `@github/copilot`                 |  `1.0.80` |
| `glm-acp-agent`  | `glm-acp-agent`                   |   `1.5.0` |
| `opencode`       | `opencode-ai`                     | `1.18.18` |
| `pi-acp`         | `pi-acp`                          |  `0.0.33` |
| `pi`             | `@earendil-works/pi-coding-agent` |  `0.84.2` |
| `pi-mcp-adapter` | `pi-mcp-adapter`                  |  `2.26.0` |

## Use with AML

```ts
import { dockerSandbox } from "@aml-jsx/sdk"

const sandbox = dockerSandbox({
  image: "wearesingular/aml-agent-sandbox:0.1.0",
})
```

The image defaults to UID/GID `1000:1000`. For a same-host Docker bind mount owned by another user, pass that identity explicitly:

```ts
const sandbox = dockerSandbox({
  image: "wearesingular/aml-agent-sandbox:0.1.0",
  user: `${process.getuid?.()}:${process.getgid?.()}`,
})
```

Inject model credentials when the Sandbox starts. Do not bake API keys, Agent home directories, repository credentials, or application state into image layers.

## Use as a base image

Application images should add only their project toolchain and runtime dependencies:

```dockerfile
FROM wearesingular/aml-agent-sandbox:0.1.0

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
USER aml
```

Add project-specific dependencies in your own image instead of installing them every time a Sandbox starts.

## Build and verify

From an AML repository checkout:

```sh
cd images/aml-agent-sandbox
npm run build
npm run check
npm run smoke --prefix ../.. -- --sandbox docker
```

The conformance check verifies the runtime user, writable paths, required utilities, exact package versions, Agent startup probes, and redistributed notices. The credentialed smoke matrix proves real ACP sessions, AML JavaScript Tool invocation, structured output, Workspace persistence, and cleanup.

## Releasing

Stable image releases run locally, not in GitHub Actions. Start from a clean `main` checkout that matches `origin/main`, authenticate the GitHub CLI, install [Cosign](https://docs.sigstore.dev/cosign/system_config/installation/), and run this from the repository root:

```sh
npm run release:docker
```

The command first checks that the caller's selected Buildx builder can publish SBOM and provenance attestations. Use an
existing `docker-container` builder, or enable Docker's containerd image store; the release does not create or switch
builders. Docker Hub's browser login then uses a temporary Docker configuration while the caller's Buildx configuration,
selected builder, and state remain available. The temporary credentials are deleted when the command exits. Release It
then prompts for the version, runs the image audit/build/conformance checks,
creates a `docker-vX.Y.Z` release commit and tag, publishes the image to Docker Hub, verifies its digest, and signs that
digest. The active `gh` account authorizes the source tag's GitHub Release; it is not used to publish a stable GHCR
image.

Browser authentication follows each maintainer's local setup. Under WSL, set `BROWSER` to an installed host-browser
opener such as `wslview`, or open the displayed device URL in Windows and enter the one-time code. Native Linux and
macOS maintainers can keep their normal browser configuration. No browser path is required by the release scripts.

If image publication fails after Release It creates the release commit and tag, recover that same version from a clean `main` checkout:

```sh
npm run release:docker -- --recover
```

Recovery requires `HEAD` to have the `docker-vX.Y.Z` tag matching this package's version. It safely reruns image publication and creates the GitHub Release if the first attempt did not reach that step.

Preview the versioning and Git release flow without publishing:

```sh
npm run release:docker -- --dry-run
```

After publication completes, independently verify the immutable digest, exact Cosign signer policy, BuildKit SBOM and
provenance, all stable tags, and the GitHub Release:

```sh
npm run verify:release --prefix images/aml-agent-sandbox -- 0.1.0 sha256:<digest> \
  --certificate-identity '<exact Fulcio certificate identity>' \
  --certificate-oidc-issuer 'https://github.com/login/oauth'
```

Use the signer identity approved for the maintainer who performed the local keyless signing. The verifier requires an
exact identity and issuer; it does not accept wildcard trust policy.

## Channels, tags, and platforms

- Docker Hub `0.1.0`: immutable image release
- Docker Hub `sha-<commit>`: source revision build
- Docker Hub `latest`: newest fully validated stable release
- GHCR `dev`: mutable image built after relevant changes reach `main`
- initial platform: `linux/amd64`

Pin an immutable Docker Hub version or digest in production. GHCR `dev` is for repository and integration development.

## Security and licensing

The image runs as non-root, but container isolation, network policy, Linux capabilities, seccomp/AppArmor, resource limits, secret injection, and the Docker daemon remain deployment responsibilities.

AML image source is MIT licensed. Bundled software retains its own license. GitHub Copilot CLI is redistributed unmodified as one component of AML's multi-Agent runtime under the GitHub Copilot CLI License. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and the license files shipped under `/usr/share/doc/aml-agent-sandbox`.

[Source](https://github.com/we-are-singular/aml/tree/main/images/aml-agent-sandbox), [changelog](https://github.com/we-are-singular/aml/blob/main/images/aml-agent-sandbox/CHANGELOG.md), and issues live in the AML repository.
