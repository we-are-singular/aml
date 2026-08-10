# @aml-jsx/cli

`aml` executes an AML workflow file with a live runtime and emits structured or plain output.

## Install/build

- `npm run build --workspace=@aml-jsx/cli`
- `node apps/cli/dist/index.js ...`

## Usage

- `aml run ./path/to/workflow.tsx`
- `aml run ./path/to/workflow.tsx --entry main`
- `aml run ./path/to/workflow.tsx --trace`
- `aml run ./path/to/workflow.tsx --trace --capture-content`
- `aml run ./path/to/workflow.tsx --json`
- `aml run ./path/to/workflow.tsx --runtime-env-file .env.custom`

## Export contract

The command loads the file through Vite/Vite-node transforms and resolves the workflow as:

1. `default` export (preferred)
2. `main` named export if it is a function

If a named export is passed with `--entry`, that export is resolved and executed.

## Environment loading

The CLI loads Vite-style environment files from the workflow directory before execution.

Defaults:

- environment mode: `NODE_ENV` (or `development`)
- env files: `.env`, `.env.local`, `.env.${mode}`, `.env.${mode}.local`
- prefix: all variables (so `process.env` gets values from files)
- `--runtime-env-file`: optional additional file loaded after the Vite env files (for explicit overrides)
  - Note: `--env-file` is reserved by `node`, so we keep `--runtime-env-file` for CLI usage.

Current behavior is to only set missing process variables, so externally provided
env values are preserved.

If `NODE_ENV=dev`, the CLI follows Vite behavior and loads `.env` plus `.env.dev`
(plus `.env.local` and `.env.dev.local` when present).
