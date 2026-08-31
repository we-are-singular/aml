# AML Agent Sandbox

AML Agent Sandbox is a ready-to-use Debian image for running AI agents and AML workflows. Every variant includes the `aml` CLI, AML SDK, Node.js and npm, Python and pip, Git, jq, and common command-line tools. The default `full` variant also includes Codex, GitHub Copilot, GLM, OpenCode, and Pi.

Pull stable releases from Docker Hub:

```sh
docker pull wearesingular/aml-agent-sandbox:latest
```

Docker Hub is the canonical release registry for semantic versions and `latest` ([see all versions](https://agent-markup-language.com/docs/reference/changelog/sandbox/)).

Read the [AML Agent Sandbox image guide](https://agent-markup-language.com/docs/sandbox-images/) for variant selection, complete tag behavior, the bleeding-edge GHCR channel, AML configuration, and extension guidance.

The latest relevant `main` revision is published separately as the mutable, non-versioned `ghcr.io/we-are-singular/aml-agent-sandbox:dev` image for repository development and smoke testing. This channel always contains the full all-Agent dependency set; GHCR does not publish single-Agent `dev` variants. It is not a Docker Hub release.

## Variants

The unqualified version and `latest` tags remain aliases for `full`. Pin a versioned variant or digest for reproducible deployments.

| Variant  | Immutable tag         | Moving tag       | Included Agent versions                               |
| -------- | --------------------- | ---------------- | ----------------------------------------------------- |
| Full     | `X.Y.Z`, `X.Y.Z-full` | `latest`, `full` | Every Agent listed below                              |
| Codex    | `X.Y.Z-codex`         | `codex`          | Codex `0.147.0`, Codex ACP `1.4.0`                    |
| Copilot  | `X.Y.Z-copilot`       | `copilot`        | GitHub Copilot CLI `1.0.80`                           |
| GLM      | `X.Y.Z-glm`           | `glm`            | GLM ACP Agent `1.5.0`                                 |
| OpenCode | `X.Y.Z-opencode`      | `opencode`       | OpenCode `1.18.18`                                    |
| Pi       | `X.Y.Z-pi`            | `pi`             | Pi `0.84.2`, Pi ACP `0.0.33`, Pi MCP Adapter `2.26.0` |

Every variant is built from the same Dockerfile. All variants contain AML, Node.js and npm, Python and pip, Git, jq, and the same runtime layout; a single-Agent variant installs only that Agent's ACP adapter and native runtime. These are clean builds, not deletions layered on top of `full`, and no Agent is installed when a Sandbox starts.

Choose `full` when the application may use different Agents. Choose the matching single-Agent variant when the Agent is fixed and you want the smaller image.

## Included runtime

- A Debian/glibc environment with Node.js and npm, Python and pip, Git, jq, and common coding tools
- `aml` on `PATH` with an image-provided SDK available to bare imports from mounted Workspaces
- the Agent and ACP commands selected by the image variant
- non-root `aml` user with writable home, `/tmp`, and `/workspace`
- no embedded credentials, Agent state, application-specific dependencies, cloud CLIs, Docker daemon, browsers, compilers, or additional language runtimes

The Dockerfile and package manifests are the source of truth for the exact tools and versions in each image release.

## Run an AML workflow

A clean mounted Workspace does not need a local `package.json`, `node_modules`, or dependency installation. For example, save this single file as `workflow.tsx`:

```tsx
/** @jsxImportSource @aml-jsx/sdk */
import { Fragment } from "@aml-jsx/sdk"

export default <Fragment>hello from the image</Fragment>
```

Then run it from any working directory inside the container:

```sh
aml run /workspace/workflow.tsx
```

The packages are installed reproducibly under `/opt/aml-agent-sandbox/node_modules`. `/node_modules` points to that tree so standard Node and Vite ancestor resolution can find bare imports from arbitrary paths, including `/workspace` when a provider replaces it with a bind mount. `NODE_PATH` is not used. Add a local dependency manifest or extend the image when a workflow needs packages beyond the embedded SDK.

## Use with AML

Omitting `image` uses the full `latest` image:

```ts
import { dockerSandbox } from "@aml-jsx/sdk"

const sandbox = dockerSandbox({
  image: "wearesingular/aml-agent-sandbox:latest",
})
```

Image selection does not select the Agent provider. Configure both sides with the same Agent. For example, use OpenCode with its immutable OpenCode image:

```ts
import { AmlRuntime, dockerSandbox, opencodeAgent } from "@aml-jsx/sdk"

const runtime = new AmlRuntime({
  agentProvider: opencodeAgent({
    env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY! },
  }),
  sandboxProvider: dockerSandbox({
    image: "wearesingular/aml-agent-sandbox:X.Y.Z-opencode",
  }),
})
```

Pairing a provider with another Agent's thin image fails because the required executable is intentionally absent. Credentials are not included in any variant; inject them when the Sandbox starts.

The image defaults to UID/GID `1000:1000`. For a same-host Docker bind mount owned by another user, pass that identity explicitly:

```ts
const sandbox = dockerSandbox({
  image: "wearesingular/aml-agent-sandbox:latest",
  user: `${process.getuid?.()}:${process.getgid?.()}`,
})
```

Inject model credentials when the Sandbox starts. Do not bake API keys, Agent home directories, repository credentials, or application state into image layers.

## Extend a variant

Application images should start from the smallest matching variant and add only their project toolchain and runtime dependencies. This example adds the SQLite CLI to the OpenCode image:

```dockerfile
FROM wearesingular/aml-agent-sandbox:X.Y.Z-opencode

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends sqlite3 \
    && rm -rf /var/lib/apt/lists/*
USER aml
WORKDIR /workspace
```

Build and use the derived image:

```sh
docker build --tag example/aml-opencode:1 .
```

```ts
const sandbox = dockerSandbox({
  image: "example/aml-opencode:1",
})
```

Add project-specific dependencies in your own image instead of installing them every time a Sandbox starts. Build tools are not included in the published runtime; add them only when a dependency needs compilation, and avoid retaining them in the final stage when they are build-only.

## Build and smoke

From an AML repository checkout:

```sh
cd images/sandbox
npm run build
npm run check
npm run build -- opencode
npm run check -- opencode
npm run build:all
npm run check:all
npm run smoke --prefix ../.. -- --sandbox docker
```

The image smoke checks its non-root user, writable runtime directories, promised commands, excluded Agent commands, downstream login-shell behavior, and one clean AML workflow. Each build prints its uncompressed local image size. The credentialed smoke matrix separately exercises real ACP sessions, AML JavaScript Tools, structured output, Workspace persistence, and cleanup.

## Releasing

Stable image releases run locally, not in GitHub Actions. Start from a clean `main` checkout that matches `origin/main`, authenticate the GitHub CLI, install [Cosign](https://docs.sigstore.dev/cosign/system_config/installation/), and run this from the repository root:

```sh
npm run release:sandbox
```

The command checks that Docker Buildx and Cosign are installed. Docker Hub's browser login then uses a temporary Docker configuration while the caller's Buildx configuration and selected builder remain available. The temporary credentials are deleted when the command exits. Release It prompts for the version, builds and checks every variant, and creates one `sandbox-vX.Y.Z` release commit and tag. Publication pushes the immutable variant tags with SBOM and provenance attestations, runs each Agent's real Docker smoke against the exact pushed digest, signs every digest, and only then updates the moving tags. The active `gh` account authorizes the source tag's GitHub Release.

Before authentication, the release inspects the selected Buildx driver. An existing attestation-capable builder is used as configured. When the selected builder uses the incompatible `docker` driver, the release creates or reuses the `aml-agent-sandbox-publisher` `docker-container` builder for its child processes without changing the caller's global builder selection.

Publication requests SBOM and provenance attestations directly from Buildx. If the selected builder cannot publish them, the real build fails without a separate builder-analysis layer.

Browser authentication follows each maintainer's local setup. Under WSL, set `BROWSER` to an installed host-browser opener such as `wslview`, or open the displayed device URL in Windows and enter the one-time code. Native Linux and macOS maintainers can keep their normal browser configuration. No browser path is required by the release scripts.

If image publication fails after Release It creates the release commit and tag, recover that same version from a clean `main` checkout:

```sh
npm run release:sandbox -- --recover
```

Recovery requires `HEAD` to have the `sandbox-vX.Y.Z` tag matching this package's version. It safely reruns image publication and creates the GitHub Release if the first attempt did not reach that step.

Preview the versioning and Git release flow without publishing:

```sh
npm run release:sandbox -- --dry-run
```

After publication completes, independently verify every variant tag and digest, the exact Cosign signer policy, BuildKit SBOM and provenance, and the GitHub Release:

```sh
npm run verify:release --prefix images/sandbox -- X.Y.Z \
  --certificate-identity '<exact Fulcio certificate identity>' \
  --certificate-oidc-issuer 'https://github.com/login/oauth'
```

Use the signer identity approved for the maintainer who performed the local keyless signing. The verifier requires an
exact identity and issuer; it does not accept wildcard trust policy.

## Channels, tags, and platforms

- Docker Hub `X.Y.Z` and `X.Y.Z-full`: immutable full image release
- Docker Hub `latest` and `full`: newest stable full image
- Docker Hub `X.Y.Z-<agent>`: immutable single-Agent image
- Docker Hub `<agent>`: newest stable single-Agent image
- GHCR `dev`: mutable development build from `main`
- initial platform: `linux/amd64`

Pin an immutable Docker Hub version or digest in production. Do not use GHCR `dev` as a production pin.

## Security and licensing

The image runs as non-root, but container isolation, network policy, Linux capabilities, seccomp/AppArmor, resource limits, secret injection, and the Docker daemon remain deployment responsibilities.

AML image source is MIT licensed. Bundled software retains its own license. The `full` and `copilot` variants redistribute GitHub Copilot CLI unmodified under the GitHub Copilot CLI License. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and the license files shipped under `/usr/share/doc/aml-agent-sandbox`.

[Source](https://github.com/we-are-singular/aml/tree/main/images/sandbox),
[changelog](https://agent-markup-language.com/docs/reference/changelog/sandbox/), and issues live in the AML repository.
