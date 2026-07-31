# `@aml-jsx/sdk`

Agent Markup Language (AML) is an asynchronous TypeScript and JSX runtime for composing provider-agnostic agent workflows.

```sh
npm install @aml-jsx/sdk
```

Configure TypeScript to use AML's JSX runtime:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@aml-jsx/sdk"
  }
}
```

Then evaluate an AML tree:

```tsx
import { Agent, AmlRuntime, opencodeAgent } from "@aml-jsx/sdk"

const runtime = new AmlRuntime()
const result = await runtime.evaluate(<Agent provider={opencodeAgent({})}>Summarize this repository.</Agent>)
```

The built-in coding-agent factories are thin profiles over AML's shared Agent Client Protocol (ACP) session engine:

```tsx
import { Agent, AmlRuntime, piAgent } from "@aml-jsx/sdk"

const Pi = piAgent({
  env: { OPENCODE_API_KEY: process.env.OPENCODE_API_KEY ?? "" },
  model: "opencode-go/glm-5.1",
})

const result = await new AmlRuntime().evaluate(<Agent provider={Pi}>Say hello.</Agent>)
```

Codex, OpenCode, and Pi use the same ACP lifecycle on the trusted local host and inside supported Sandboxes. Agents optimistically receive their native filesystem, shell, and network capabilities unless `<Agent permissions>` narrows them; the enclosing Sandbox remains authoritative. `<Tool>` is reserved for JavaScript functions created with `defineTool()`. The selected environment must contain the compatible ACP Agent executable; AML does not install it implicitly. Provider-specific options remain on each factory.

The public factory names are `codexAgent()`, `opencodeAgent()`, and `piAgent()`.

## Coding agents

Install AML's coding-agent skill for current workflow patterns, runtime semantics, providers, and testing guidance:

```sh
npx skills add we-are-singular/aml --skill aml-jsx
```

Add `-g` for a global installation.

AML is under active development. Public APIs and examples may change before the first stable release.

- [Documentation and examples](https://github.com/we-are-singular/aml)
- [Specification](https://github.com/we-are-singular/aml/blob/main/SPEC.md)
- [Project website](https://agent-markup-language.com/)

## License

MIT
