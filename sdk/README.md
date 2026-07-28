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

## Coding agents

Install AML's coding-agent skill for current workflow patterns, runtime semantics, providers, and testing guidance:

```sh
npx skills add we-are-singular/aml --skill aml-jsx
```

Add `-g` for a global installation.

AML is under active development. Public APIs and examples may change before the first stable release.

- [Documentation and examples](https://github.com/we-are-singular/aml)
- [Specification](https://github.com/we-are-singular/aml/blob/main/SPEC.md)
- [Project website](https://aml.wearesingular.com/)

## License

MIT
