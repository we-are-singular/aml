# AML Agent Sandbox

Run [AML](https://agent-markup-language.com/) workflows and ACP coding agents in ready-to-use Debian containers. The images include AML, the selected Agent runtime, Node.js, Python, Git, and the command-line tools agents commonly need.

```sh
docker pull wearesingular/aml-agent-sandbox:latest
```

## Choose an image

Use `latest` when your application can select different Agents. Use an Agent-specific tag when every workflow uses the same Agent and you want a smaller image.

| Image    | Moving tag         | Versioned tag           |
| -------- | ------------------ | ----------------------- |
| Full     | `latest` or `full` | `X.Y.Z` or `X.Y.Z-full` |
| Codex    | `codex`            | `X.Y.Z-codex`           |
| Copilot  | `copilot`          | `X.Y.Z-copilot`         |
| GLM      | `glm`              | `X.Y.Z-glm`             |
| OpenCode | `opencode`         | `X.Y.Z-opencode`        |
| Pi       | `pi`               | `X.Y.Z-pi`              |

Moving tags follow the newest stable image in their lane. Use a versioned tag or digest when the deployment must stay on one image.

Every variant contains the same AML and system runtime. Each Agent-specific variant is built directly from the shared base plus its selected Agent.

## Use with AML

The Docker Sandbox uses the full image by default:

```ts
import { dockerSandbox } from "@aml-jsx/sdk"

const sandbox = dockerSandbox()
```

Image selection does not select the Agent. Configure matching Agent and Sandbox providers together. This example runs OpenCode with the smaller OpenCode image:

```ts
import { AmlRuntime, dockerSandbox, opencodeAgent } from "@aml-jsx/sdk"

const apiKey = process.env.OPENCODE_API_KEY
if (!apiKey) throw new Error("OPENCODE_API_KEY is required")

const runtime = new AmlRuntime({
  agentProvider: opencodeAgent({
    model: "opencode-go/deepseek-v4-flash",
    env: { OPENCODE_API_KEY: apiKey },
  }),
  sandboxProvider: dockerSandbox({
    image: "wearesingular/aml-agent-sandbox:opencode",
  }),
})
```

An OpenCode image does not contain Codex, Copilot, GLM, or Pi. Pairing it with another Agent provider fails because that Agent's executable is absent.

## What's inside

Every image includes:

- the `aml` CLI and `@aml-jsx/sdk`;
- Node.js 26 and npm;
- Python 3, pip, and `venv`;
- Git, OpenSSH, Bash, curl, CA certificates, jq, ripgrep, patch, and common shell tools;
- a Debian Bookworm/glibc runtime;
- a non-root `aml` user with writable `/home/aml`, `/tmp`, and `/workspace`.

The image contains no credentials, Agent login state, project dependencies, browsers, cloud CLIs, Docker daemon, compilers, or broad language toolchains.

Inspect a variant directly:

```sh
docker run --rm wearesingular/aml-agent-sandbox:opencode opencode --version
docker run --rm wearesingular/aml-agent-sandbox:opencode aml --version
```

## Add project dependencies

Build on the smallest variant that contains your Agent. This example adds SQLite to OpenCode:

```dockerfile
FROM wearesingular/aml-agent-sandbox:opencode

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends sqlite3 \
    && rm -rf /var/lib/apt/lists/*

USER aml
WORKDIR /workspace
```

Add project tools to a derived image instead of reinstalling them whenever a Sandbox starts.

## Credentials and security

Pass model credentials when the Sandbox starts. Do not bake API keys, Agent homes, repository credentials, or application state into an image layer.

The images run as a non-root user, but the deployment still owns network policy, Linux capabilities, seccomp/AppArmor, resource limits, secret injection, and Docker daemon security. Pin trusted digests and apply a container policy appropriate for the code your Agent can execute.

## Learn more

- [Image guide and complete tag reference](https://agent-markup-language.com/docs/sandbox-images/)
- [Run AML in a Sandbox image](https://agent-markup-language.com/docs/cookbook/sandbox-image/)
- [Docker Sandbox provider](https://agent-markup-language.com/docs/providers/sandboxes/docker/)
- [Image changelog](https://agent-markup-language.com/docs/reference/changelog/sandbox/)
- [Source and issues](https://github.com/we-are-singular/aml)

AML image source is MIT licensed. Bundled software keeps its own license.
