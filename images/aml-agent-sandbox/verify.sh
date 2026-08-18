#!/bin/sh
set -eu

expected_user="aml"
workspace_access="${AML_VERIFY_WORKSPACE_ACCESS:-read-write}"

test "$(id -un)" = "$expected_user"
test -w "$HOME"
test -w /tmp

case "$workspace_access" in
  read-write)
    test -w /workspace
    workflow_directory="/workspace/arbitrary-clean/nested"
    mkdir -p "$workflow_directory"
    cp /fixture/import-sdk.mjs /fixture/workflow.tsx "$workflow_directory/"
    ;;
  read-only)
    test ! -w /workspace
    workflow_directory="/workspace"
    ;;
  *)
    printf 'unknown Workspace access mode: %s\n' "$workspace_access" >&2
    exit 1
    ;;
esac

for command_name in sh bash mkdir rm chmod readlink dirname tar git node npm python python3 pip pip3; do
  command -v "$command_name" >/dev/null
done

for command_name in curl dig fd file ip jq lsof nc patch ping ps rg ssh sqlite3 tree unzip xz zip; do
  command -v "$command_name" >/dev/null
done

for command_name in aml codex-acp codex copilot glm-acp-agent opencode pi-acp pi pi-mcp-adapter; do
  command -v "$command_name" >/dev/null
done

test "$(readlink /node_modules)" = "/opt/aml-agent-sandbox/node_modules"
test ! -e "$workflow_directory/node_modules"
test ! -e "$workflow_directory/package.json"
test ! -e "$workflow_directory/tsconfig.json"

test "$(node --version | cut -d. -f1)" = "v26"
test "$(python3 --version | cut -d. -f1)" = "Python 3"
test "$(python --version)" = "$(python3 --version)"

python -m venv /tmp/aml-python-venv
test -x /tmp/aml-python-venv/bin/pip
rm -rf /tmp/aml-python-venv

node <<'NODE'
const manifest = require("/opt/aml-agent-sandbox/package.json")

for (const [name, version] of Object.entries(manifest.dependencies)) {
  const installed = require(`/opt/aml-agent-sandbox/node_modules/${name}/package.json`).version
  if (installed !== version) throw new Error(`${name}: expected ${version}, found ${installed}`)
}
NODE

package_version() {
  node -e 'process.stdout.write(require("/opt/aml-agent-sandbox/package.json").dependencies[process.argv[1]])' "$1"
}

test "$(codex --version)" = "codex-cli $(package_version @openai/codex)"
test "$(opencode --version)" = "$(package_version opencode-ai)"
test "$(pi --version)" = "$(package_version @earendil-works/pi-coding-agent)"
aml --version | grep -F "aml/$(package_version @aml-jsx/cli) " >/dev/null
copilot --version | grep -F "GitHub Copilot CLI $(package_version @github/copilot)" >/dev/null
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

# Run outside the mounted Workspace to prove that neither package resolution
# nor writable invocation state depends on the caller's current directory.
invocation_directory="/tmp/aml-verification/invocation"
mkdir -p "$invocation_directory"
cd "$invocation_directory"
test "$(node "$workflow_directory/import-sdk.mjs")" = "sdk bare import ok"
test "$(aml run "$workflow_directory/workflow.tsx" 2>diagnostics.log)" = "embedded AML workflow"
grep -F "aml: starting run" diagnostics.log >/dev/null
grep -F "(ok)" diagnostics.log >/dev/null

printf 'aml-agent-sandbox %s Workspace conformance passed\n' "$workspace_access"
