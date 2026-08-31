ARG AML_AGENT_SANDBOX_IMAGE=aml-agent-sandbox:dev
FROM ${AML_AGENT_SANDBOX_IMAGE}

ARG AML_AGENT_SANDBOX_COMMANDS="codex-acp codex copilot glm-acp-agent opencode pi-acp pi pi-mcp-adapter"
ARG AML_AGENT_SANDBOX_EXCLUDED_COMMANDS=""

# A downstream image must be able to use AML and its advertised Agents during
# its build, including from the login shells commonly used by setup scripts.
RUN for command_name in aml $AML_AGENT_SANDBOX_COMMANDS; do \
        command -v "$command_name" >/dev/null; \
    done \
    && for command_name in $AML_AGENT_SANDBOX_EXCLUDED_COMMANDS; do \
        if command -v "$command_name" >/dev/null; then exit 1; fi; \
    done \
    && aml --version >/dev/null

RUN bash -lc 'for command_name in aml $AML_AGENT_SANDBOX_COMMANDS; do command -v "$command_name" >/dev/null; done; for command_name in $AML_AGENT_SANDBOX_EXCLUDED_COMMANDS; do if command -v "$command_name" >/dev/null; then exit 1; fi; done; aml --version >/dev/null'
