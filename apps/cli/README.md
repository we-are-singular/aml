# @aml-jsx/cli

`aml` executes trusted Agent Markup Language TypeScript, TSX, and JavaScript workflow files without application glue.
The package is experimental: its command and module-export contracts may change before they are declared stable.

## Install

Install the CLI beside the SDK used by your workflow:

```sh
npm install @aml-jsx/sdk
npm install --save-dev @aml-jsx/cli
```

Configure AML as the JSX runtime in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@aml-jsx/sdk"
  }
}
```

Node.js 26 and npm 11 are the supported minimums.

## Run a workflow

```sh
npx aml run ./workflow.tsx
```

```tsx
import { Agent } from "@aml-jsx/sdk"
import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"

const provider = new DeterministicAgentProvider({
  name: "cli-example",
  respond: request => ({ text: `Reviewed: ${request.prompt}` }),
})

export default <Agent provider={provider}>README.md</Agent>
```

This credential-free workflow prints `Reviewed: README.md`. Replace the deterministic provider with a supported live
Agent provider when the workflow is ready to call a model.

The workflow owns providers, models, credentials, Sandboxes, and Workspaces. The CLI stays provider-neutral and owns
source loading, environment loading, runtime execution, diagnostics, and output formatting.

Export the AML tree itself. Creating and evaluating another `AmlRuntime` inside the exported function starts a nested
run outside the CLI's tracing, cancellation, and runtime ownership.

## Export contract

`aml run` resolves one exported AML value:

1. the export selected by `--entry`;
2. otherwise the default export;
3. otherwise an exported `main()` function.

The selected value may be an AML renderable or a zero-argument function or promise resolving to one.

## Command reference

```text
aml run <workflowFile> [options]

-e, --entry <name>          Select a named export
--runtime-env-file <file>   Apply an explicit env file last
--trace                     Write metadata-only trace events to stderr
--capture-content           Include sensitive content in trace output; implies --trace
--json                      Write a JSON success envelope to stdout
-h, --help                  Show command help
-v, --version               Show CLI, platform, and Node versions
```

Workflow results are the only content written to stdout. Lifecycle logs, traces, and errors go to stderr, so ordinary
output remains safe to pipe.

## Environment loading

Before importing the workflow, the CLI loads these files from its directory using `NODE_ENV`, or `development` when it
is absent:

```text
.env
.env.local
.env.<mode>
.env.<mode>.local
```

Existing process variables win. `--runtime-env-file` is parsed last and explicitly overrides both process and Vite env
values. Relative override paths are resolved from the current working directory first, then from the workflow directory.

## Source execution

The CLI has one source-execution path: Vite and `vite-node`. It starts a one-shot Vite transform environment, runs
the trusted module, and closes the environment before evaluating the selected AML value. There is intentionally no
compiler-selection flag.

Workflow modules execute as trusted code in the CLI process. An unsandboxed `<Script />` runs as a trusted host process
from the CLI working directory, and its optional relative `cwd` resolves from that directory. An AML `<Sandbox />`
constrains its descendants; it does not sandbox top-level JavaScript in the workflow module.

Read the [complete CLI guide](https://agent-markup-language.com/docs/cli/) for named exports, environment precedence,
JSON output, tracing, and the runtime ownership boundary.
