#!/bin/sh
set -eu

test "$(id -u)" -ne 0
test -w "$HOME"
test -w /tmp
test -w /workspace

for command_name in sh tar mkdir rm git node npm python aml ${AML_AGENT_SANDBOX_COMMANDS:-codex-acp codex copilot glm-acp-agent opencode pi-acp pi pi-mcp-adapter}; do
  command -v "$command_name" >/dev/null
done

for command_name in ${AML_AGENT_SANDBOX_EXCLUDED_COMMANDS:-}; do
  if command -v "$command_name" >/dev/null; then
    printf 'unexpected Agent command: %s\n' "$command_name" >&2
    exit 1
  fi
done

case " ${AML_AGENT_SANDBOX_COMMANDS:-codex-acp codex copilot glm-acp-agent opencode pi-acp pi pi-mcp-adapter} " in
  *" opencode "*) opencode --version >/dev/null ;;
esac

workflow_directory="/workspace/aml-image-smoke"
mkdir -p "$workflow_directory"
cp /fixture/import-sdk.mjs /fixture/workflow.tsx "$workflow_directory/"

test "$(node "$workflow_directory/import-sdk.mjs")" = "sdk bare import ok"
test "$(aml run "$workflow_directory/workflow.tsx" 2>/dev/null)" = "embedded AML workflow"

printf 'aml-agent-sandbox smoke passed\n'
