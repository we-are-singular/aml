ARG AML_AGENT_SANDBOX_IMAGE=aml-agent-sandbox:dev
FROM ${AML_AGENT_SANDBOX_IMAGE}

# A downstream image must be able to use AML and every advertised Agent during
# its build, including from the login shells commonly used by setup scripts.
RUN for command_name in aml codex-acp codex copilot glm-acp-agent opencode pi-acp pi pi-mcp-adapter; do \
        command -v "$command_name" >/dev/null; \
    done \
    && aml --version >/dev/null

RUN bash -lc 'for command_name in aml codex-acp codex copilot glm-acp-agent opencode pi-acp pi pi-mcp-adapter; do command -v "$command_name" >/dev/null; done; aml --version >/dev/null'
