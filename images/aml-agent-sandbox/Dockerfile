FROM node:26-bookworm-slim@sha256:cd565714d4da3e84bfd341e31448f81d47c6362198f152345297c9c1154e6341 AS build

WORKDIR /opt/aml-agent-sandbox
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && rm -rf /root/.npm

# OpenCode copies its selected executable into opencode-ai/bin during install.
# Pi's optional clipboard binaries and interactive documentation are not used by ACP.
RUN rm -rf \
    node_modules/opencode-linux-x64 \
    node_modules/opencode-linux-x64-baseline \
    node_modules/@earendil-works/pi-coding-agent/docs \
    node_modules/@earendil-works/pi-coding-agent/examples \
    node_modules/@earendil-works/pi-coding-agent/node_modules/@mariozechner/clipboard \
    node_modules/@earendil-works/pi-coding-agent/node_modules/@mariozechner/clipboard-*

FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241

ARG IMAGE_VERSION=dev
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="AML Agent Sandbox" \
    org.opencontainers.image.description="Portable runtime for AML-compatible ACP coding Agents" \
    org.opencontainers.image.version="$IMAGE_VERSION" \
    org.opencontainers.image.revision="$VCS_REF" \
    org.opencontainers.image.source="https://github.com/we-are-singular/aml/tree/main/images/aml-agent-sandbox" \
    org.opencontainers.image.url="https://hub.docker.com/r/wearesingular/aml-agent-sandbox" \
    org.opencontainers.image.licenses="MIT AND LicenseRef-GitHub-Copilot-CLI"

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
        dnsutils \
        fd-find \
        file \
        git \
        iproute2 \
        iputils-ping \
        jq \
        libatomic1 \
        lsof \
        netcat-openbsd \
        openssh-client \
        patch \
        procps \
        python3 \
        python3-pip \
        python3-venv \
        python-is-python3 \
        ripgrep \
        sqlite3 \
        tree \
        unzip \
        xz-utils \
        zip \
    && rm -rf /var/lib/apt/lists/*

# Copy Node, npm, and the complete installed packages. Starting the runtime from
# Debian avoids carrying Node image development headers that the Agents do not use.
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=build /opt/aml-agent-sandbox /opt/aml-agent-sandbox
COPY README.md CHANGELOG.md LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/aml-agent-sandbox/
COPY --from=build /opt/aml-agent-sandbox/node_modules/@github/copilot/LICENSE.md /usr/share/doc/aml-agent-sandbox/licenses/GitHub-Copilot-CLI-LICENSE.md

# Bare ESM imports search ancestor node_modules directories, not npm's global
# prefix. Root remains an ancestor when /workspace is bind-mounted.
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -s /opt/aml-agent-sandbox/node_modules /node_modules \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && ln -s /usr/bin/pip3 /usr/local/bin/pip

RUN useradd --uid 1000 --user-group --shell /bin/sh --create-home aml

RUN install -d -o aml -g aml /workspace

USER aml
WORKDIR /workspace
# Sandbox providers supply the process to run; the image must not wrap Agent
# commands in a server-specific entrypoint.
ENTRYPOINT []
CMD ["sh"]
