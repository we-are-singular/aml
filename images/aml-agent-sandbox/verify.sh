#!/bin/sh
set -eu

expected_user="aml"

test "$(id -un)" = "$expected_user"
test -w "$HOME"
test -w /tmp
test -w /workspace

for command_name in sh bash mkdir rm chmod readlink dirname tar git node npm python python3 pip pip3; do
  command -v "$command_name" >/dev/null
done

for command_name in curl dig fd file ip jq lsof nc patch ping ps rg ssh sqlite3 tree unzip xz zip; do
  command -v "$command_name" >/dev/null
done

for command_name in codex-acp codex copilot glm-acp-agent opencode pi-acp pi pi-mcp-adapter; do
  command -v "$command_name" >/dev/null
done

test "$(node --version | cut -d. -f1)" = "v26"
test "$(python3 --version | cut -d. -f1)" = "Python 3"
test "$(python --version)" = "$(python3 --version)"

python -m venv /tmp/aml-python-venv
test -x /tmp/aml-python-venv/bin/pip
rm -rf /tmp/aml-python-venv
test "$(codex --version)" = "codex-cli 0.147.0"
test "$(opencode --version)" = "1.18.18"
test "$(pi --version)" = "0.84.2"

node <<'NODE'
const expected = {
  "@agentclientprotocol/codex-acp": "1.4.0",
  "@earendil-works/pi-coding-agent": "0.84.2",
  "@github/copilot": "1.0.80",
  "@openai/codex": "0.147.0",
  "glm-acp-agent": "1.5.0",
  "opencode-ai": "1.18.18",
  "pi-acp": "0.0.33",
  "pi-mcp-adapter": "2.26.0",
}

for (const [name, version] of Object.entries(expected)) {
  const installed = require(`/opt/aml-agent-sandbox/node_modules/${name}/package.json`).version
  if (installed !== version) throw new Error(`${name}: expected ${version}, found ${installed}`)
}
NODE

copilot --version | grep -F "GitHub Copilot CLI 1.0.80" >/dev/null
glm-acp-agent --help | grep -F "Start the ACP stdio loop" >/dev/null
pi-acp --help >/dev/null
pi-mcp-adapter --help | grep -F "pi-mcp-adapter helper" >/dev/null

test ! -e /opt/aml-agent-sandbox/node_modules/opencode-linux-x64-baseline
test ! -e /opt/aml-agent-sandbox/node_modules/@earendil-works/pi-coding-agent/node_modules/@mariozechner/clipboard

set +e
timeout 1 codex-acp --help </dev/null >/dev/null 2>&1
codex_acp_status=$?
set -e
test "$codex_acp_status" -eq 124

test -f /usr/share/doc/aml-agent-sandbox/README.md
test -f /usr/share/doc/aml-agent-sandbox/THIRD_PARTY_NOTICES.md
test -f /usr/share/doc/aml-agent-sandbox/licenses/GitHub-Copilot-CLI-LICENSE.md

printf 'aml-agent-sandbox conformance passed\n'
