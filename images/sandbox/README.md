# AML Agent Sandbox

AML Agent Sandbox is a ready-to-use Debian image for running AI agents and AML workflows. The `aml` CLI, AML SDK,
Codex, GitHub Copilot, GLM, OpenCode, Pi, Node.js, Python, Git, and common command-line tools are already installed.

Pull stable releases from Docker Hub:

```sh
docker pull wearesingular/aml-agent-sandbox:latest
```

Docker Hub is the canonical release registry for semantic versions and `latest`
([see all versions](https://agent-markup-language.com/docs/reference/changelog/sandbox/)).

The latest relevant `main` revision is published separately as `ghcr.io/we-are-singular/aml-agent-sandbox:dev` for
repository development and smoke testing. It is not a Docker Hub release.

## Included runtime

- A Debian/glibc environment with Node.js, Python, Git, and common coding tools
- `aml` on `PATH` with an image-provided SDK available to bare imports from mounted Workspaces
- the Agent and ACP commands used by AML's built-in providers
- non-root `aml` user with writable home, `/tmp`, and `/workspace`
- no embedded credentials, Agent state, application-specific dependencies, cloud CLIs, Docker daemon, browsers, compilers, or additional language runtimes

The Dockerfile and package manifests are the source of truth for the exact tools and versions in each image release.

## Run an AML workflow

A clean mounted Workspace does not need a local `package.json`, `node_modules`, or dependency installation. For
example, save this single file as `workflow.tsx`:

```tsx
/** @jsxImportSource @aml-jsx/sdk */
import { Fragment } from "@aml-jsx/sdk"

export default <Fragment>hello from the image</Fragment>
```

Then run it from any working directory inside the container:

```sh
aml run /workspace/workflow.tsx
```

The packages are installed reproducibly under `/opt/aml-agent-sandbox/node_modules`. `/node_modules` points to that
tree so standard Node and Vite ancestor resolution can find bare imports from arbitrary paths, including `/workspace`
when a provider replaces it with a bind mount. `NODE_PATH` is not used. Add a local dependency manifest or extend the
image when a workflow needs packages beyond the embedded SDK.

## Use with AML

```ts
import { dockerSandbox } from "@aml-jsx/sdk"

const sandbox = dockerSandbox({
  image: "wearesingular/aml-agent-sandbox:latest",
})
```

The image defaults to UID/GID `1000:1000`. For a same-host Docker bind mount owned by another user, pass that identity explicitly:

```ts
const sandbox = dockerSandbox({
  image: "wearesingular/aml-agent-sandbox:latest",
  user: `${process.getuid?.()}:${process.getgid?.()}`,
})
```

Inject model credentials when the Sandbox starts. Do not bake API keys, Agent home directories, repository credentials, or application state into image layers.

## Use as a base image

Application images should add only their project toolchain and runtime dependencies:

```dockerfile
FROM wearesingular/aml-agent-sandbox:latest

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
USER aml
```

Add project-specific dependencies in your own image instead of installing them every time a Sandbox starts.

## Build and smoke

From an AML repository checkout:

```sh
cd images/sandbox
npm run build
npm run check
npm run smoke --prefix ../.. -- --sandbox docker
```

The image smoke checks its non-root user, writable runtime directories, promised commands, and one clean AML workflow.
The credentialed smoke matrix separately exercises real ACP sessions, AML JavaScript Tools, structured output,
Workspace persistence, and cleanup.

## Releasing

Stable image releases run locally, not in GitHub Actions. Start from a clean `main` checkout that matches `origin/main`, authenticate the GitHub CLI, install [Cosign](https://docs.sigstore.dev/cosign/system_config/installation/), and run this from the repository root:

```sh
npm run release:sandbox
```

The command checks that Docker Buildx and Cosign are installed. Docker Hub's browser login then uses a temporary Docker
configuration while the caller's Buildx configuration and selected builder remain available. The temporary credentials
are deleted when the command exits. Release It then prompts for the version, runs the image audit/build/smoke checks,
creates a `sandbox-vX.Y.Z` release commit and tag, publishes the image to Docker Hub, verifies its digest, and signs that
digest. The active `gh` account authorizes the source tag's GitHub Release.

Before authentication, the release inspects the selected Buildx driver. An existing attestation-capable builder is used
as configured. When the selected builder uses the incompatible `docker` driver, the release creates or reuses the
`aml-agent-sandbox-publisher` `docker-container` builder for its child processes without changing the caller's global
builder selection.

Publication requests SBOM and provenance attestations directly from Buildx. If the selected builder cannot publish them,
the real build fails without a separate builder-analysis layer.

Browser authentication follows each maintainer's local setup. Under WSL, set `BROWSER` to an installed host-browser
opener such as `wslview`, or open the displayed device URL in Windows and enter the one-time code. Native Linux and
macOS maintainers can keep their normal browser configuration. No browser path is required by the release scripts.

If image publication fails after Release It creates the release commit and tag, recover that same version from a clean `main` checkout:

```sh
npm run release:sandbox -- --recover
```

Recovery requires `HEAD` to have the `sandbox-vX.Y.Z` tag matching this package's version. It safely reruns image publication and creates the GitHub Release if the first attempt did not reach that step.

Preview the versioning and Git release flow without publishing:

```sh
npm run release:sandbox -- --dry-run
```

After publication completes, independently verify the immutable digest, exact Cosign signer policy, BuildKit SBOM and
provenance, both stable tags, and the GitHub Release:

```sh
npm run verify:release --prefix images/sandbox -- X.Y.Z sha256:<digest> \
  --certificate-identity '<exact Fulcio certificate identity>' \
  --certificate-oidc-issuer 'https://github.com/login/oauth'
```

Use the signer identity approved for the maintainer who performed the local keyless signing. The verifier requires an
exact identity and issuer; it does not accept wildcard trust policy.

## Channels, tags, and platforms

- Docker Hub `X.Y.Z`: immutable image release
- Docker Hub `latest`: newest stable release
- GHCR `dev`: mutable development build from `main`
- initial platform: `linux/amd64`

Pin an immutable Docker Hub version or digest in production. Do not use GHCR `dev` as a production pin.

## Security and licensing

The image runs as non-root, but container isolation, network policy, Linux capabilities, seccomp/AppArmor, resource limits, secret injection, and the Docker daemon remain deployment responsibilities.

AML image source is MIT licensed. Bundled software retains its own license. GitHub Copilot CLI is redistributed unmodified as one component of AML's multi-Agent runtime under the GitHub Copilot CLI License. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and the license files shipped under `/usr/share/doc/aml-agent-sandbox`.

[Source](https://github.com/we-are-singular/aml/tree/main/images/sandbox),
[changelog](https://agent-markup-language.com/docs/reference/changelog/sandbox/), and issues live in the AML repository.
