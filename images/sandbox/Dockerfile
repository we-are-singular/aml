ARG IMAGE_VARIANT=full

FROM node:26-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe AS build

ARG IMAGE_VARIANT

COPY scripts/install-npm.mjs /tmp/install-npm.mjs
RUN node /tmp/install-npm.mjs && rm /tmp/install-npm.mjs

WORKDIR /opt/aml-agent-sandbox
COPY package.json package-lock.json ./
COPY scripts/variants.mjs scripts/variants.mjs
RUN node scripts/variants.mjs prepare "$IMAGE_VARIANT" package.json \
    && npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && rm -rf /root/.npm scripts

# OpenCode copies its selected executable into opencode-ai/bin during install.
# Pi's interactive documentation and examples are not used by ACP.
RUN rm -rf \
    node_modules/opencode-linux-x64 \
    node_modules/opencode-linux-x64-baseline \
    node_modules/@earendil-works/pi-coding-agent/docs \
    node_modules/@earendil-works/pi-coding-agent/examples

# Only variants containing Claude or Copilot ship their additional redistribution terms.
# A Claude variant fails to build if the SDK stops shipping its LICENSE.md notice.
RUN install -d image-licenses \
    && if [ -d node_modules/@anthropic-ai/claude-agent-sdk ]; then \
        cp node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md image-licenses/Anthropic-Claude-Agent-SDK-LICENSE.md; \
    fi \
    && if [ -f node_modules/@github/copilot/LICENSE.md ]; then \
        cp node_modules/@github/copilot/LICENSE.md image-licenses/GitHub-Copilot-CLI-LICENSE.md; \
    fi

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587

ARG IMAGE_VERSION=dev
ARG IMAGE_VARIANT=full
ARG IMAGE_LICENSES="MIT AND LicenseRef-Anthropic-Claude-Agent-SDK AND LicenseRef-GitHub-Copilot-CLI"
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="AML Agent Sandbox" \
    org.opencontainers.image.description="Portable $IMAGE_VARIANT runtime for AML-compatible ACP coding Agents" \
    org.opencontainers.image.version="$IMAGE_VERSION" \
    org.opencontainers.image.revision="$VCS_REF" \
    org.opencontainers.image.source="https://github.com/we-are-singular/aml/tree/main/images/sandbox" \
    org.opencontainers.image.url="https://hub.docker.com/r/wearesingular/aml-agent-sandbox" \
    org.opencontainers.image.licenses="$IMAGE_LICENSES"

ENV NODE_ENV=production \
    LANG=C.UTF-8 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    PATH=/opt/aml-agent-sandbox/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# OpenCode's native binary requires libatomic on Debian slim.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        jq \
        libatomic1 \
        openssh-client \
        patch \
        python3 \
        python3-pip \
        python3-venv \
        python-is-python3 \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Copy Node, npm, and the complete installed packages. Starting the runtime from
# Debian avoids carrying Node image development headers that the Agents do not use.
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=build /opt/aml-agent-sandbox /opt/aml-agent-sandbox
COPY README.md CHANGELOG.md LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/aml-agent-sandbox/
COPY --from=build /opt/aml-agent-sandbox/image-licenses/ /usr/share/doc/aml-agent-sandbox/licenses/

# Bare ESM imports search ancestor node_modules directories, not npm's global
# prefix. Root remains an ancestor when /workspace is bind-mounted. Login shells
# replace the image PATH, so advertised commands also live in /usr/local/bin for
# downstream Dockerfiles and setup scripts.
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -s /opt/aml-agent-sandbox/node_modules /node_modules \
    && ln -s /usr/bin/pip3 /usr/local/bin/pip \
    && for command_name in aml claude-agent-acp codex-acp codex copilot glm-acp-agent opencode pi-acp pi pi-mcp-adapter; do \
        if [ -e "/opt/aml-agent-sandbox/node_modules/.bin/$command_name" ]; then \
            ln -s "/opt/aml-agent-sandbox/node_modules/.bin/$command_name" "/usr/local/bin/$command_name"; \
        fi; \
    done

RUN useradd --uid 1000 --user-group --shell /bin/sh --create-home aml

RUN install -d -o aml -g aml /workspace

USER aml
WORKDIR /workspace
# Sandbox providers supply the process to run; the image must not wrap Agent
# commands in a server-specific entrypoint.
ENTRYPOINT []
CMD ["sh"]
