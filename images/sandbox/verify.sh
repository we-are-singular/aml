#!/bin/sh
set -eu

test "$(id -u)" -ne 0
test -w "$HOME"
test -w /tmp
test -w /workspace

for command_name in sh tar mkdir rm git node npm python aml ${AML_AGENT_SANDBOX_COMMANDS:-claude-agent-acp codex-acp codex copilot glm-acp-agent opencode pi-acp pi pi-mcp-adapter}; do
  command -v "$command_name" >/dev/null
done

node_version="$(node --version)"
if [ -n "${AML_AGENT_SANDBOX_NODE_VERSION:-}" ] && [ "$node_version" != "$AML_AGENT_SANDBOX_NODE_VERSION" ]; then
  printf 'unexpected Node.js version: %s (expected %s)\n' "$node_version" "$AML_AGENT_SANDBOX_NODE_VERSION" >&2
  exit 1
fi

for command_name in ${AML_AGENT_SANDBOX_EXCLUDED_COMMANDS:-}; do
  if command -v "$command_name" >/dev/null; then
    printf 'unexpected Agent command: %s\n' "$command_name" >&2
    exit 1
  fi
done

case " ${AML_AGENT_SANDBOX_COMMANDS:-claude-agent-acp codex-acp codex copilot glm-acp-agent opencode pi-acp pi pi-mcp-adapter} " in
  *" opencode "*) opencode --version >/dev/null ;;
esac

case " ${AML_AGENT_SANDBOX_COMMANDS:-claude-agent-acp codex-acp codex copilot glm-acp-agent opencode pi-acp pi pi-mcp-adapter} " in
  *" claude-agent-acp "*) test -s /usr/share/doc/aml-agent-sandbox/licenses/Anthropic-Claude-Agent-SDK-LICENSE.md ;;
esac

workflow_directory="/workspace/aml-image-smoke"
mkdir -p "$workflow_directory"
cp /fixture/import-sdk.mjs /fixture/workflow.tsx "$workflow_directory/"

test "$(node "$workflow_directory/import-sdk.mjs")" = "sdk bare import ok"
test "$(aml run "$workflow_directory/workflow.tsx" 2>/dev/null)" = "embedded AML workflow"

printf 'aml-agent-sandbox smoke passed\n'
