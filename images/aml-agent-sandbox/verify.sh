#!/bin/sh
set -eu

workspace_access="${AML_VERIFY_WORKSPACE_ACCESS:-read-write}"

test "$(id -un)" = "aml"
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

mkdir -p /tmp/aml-verification
cd /tmp/aml-verification
test "$(node "$workflow_directory/import-sdk.mjs")" = "sdk bare import ok"
test "$(aml run "$workflow_directory/workflow.tsx" 2>/dev/null)" = "embedded AML workflow"

printf 'aml-agent-sandbox %s smoke passed\n' "$workspace_access"
