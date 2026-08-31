# Providers, runtime defaults, and testing

## Built-in agent providers

The package exports five bundled Agent factories from `@aml-jsx/sdk`:

```tsx
import { codexAgent, copilotAgent, glmAgent, opencodeAgent, piAgent } from "@aml-jsx/sdk"

const OpenCode = opencodeAgent({
  directory: process.cwd(),
})

const Codex = codexAgent({
  workingDirectory: process.cwd(),
})

const Copilot = copilotAgent({
  model: "gpt-5-mini",
  workingDirectory: process.cwd(),
})

const Glm = glmAgent({
  model: "glm-5.3",
})

const Pi = piAgent({
  env: { OPENCODE_API_KEY: process.env.OPENCODE_API_KEY ?? "" },
  model: "opencode-go/deepseek-v4-flash",
})
```

Only set options needed by the application. Let credentials flow through the selected runtime environment unless the surrounding project deliberately injects them. Do not copy interactive user configuration into an automated provider invocation.

Codex, GitHub Copilot, GLM, OpenCode, and Pi are thin profiles over one ACP session engine. GLM launches the community glm-acp-agent adapter and authenticates with a Z.AI Coding Plan API key through `apiKey` or `Z_AI_API_KEY`; it is not the Z.ai ZCode harness. Preserve provider-native configuration where a profile exposes it instead of inventing a portable credential object. Copilot always receives an invocation-private `COPILOT_HOME`; it does not load the user's interactive Copilot configuration. The selected host, image, snapshot, or Sandbox package set must contain the compatible ACP Agent executable.

The shared engine owns FollowUps, JavaScript Tool and structured-output MCP bridges, cancellation, streaming, and cleanup. Profiles map Agent filesystem, shell, and network permission requests to their native controls. Inside a Sandbox, the Sandbox—not ACP permissions—is the security boundary for model-controlled operations.

Keep reusable workflows provider-agnostic:

```tsx
import type { AgentProvider } from "@aml-jsx/sdk"

function Analyze({ provider }: { provider: AgentProvider }) {
  return <Agent provider={provider}>Analyze this repository.</Agent>
}
```

Provider-specific model names, exact permission enforcement, MCP configuration, and Sandbox compatibility are not portable. Isolate those decisions at the application boundary.

## Runtime defaults and limits

`AmlRuntime` can own shared defaults and limits:

```tsx
const runtime = new AmlRuntime({
  agentProvider: OpenCode,
  sandboxProvider: Docker,
  workspaceProvider: Project,
  system: "Prefer evidence over speculation.",
  allowedTools: ["read_source"],
  allowedMcpServers: ["linear"],
  maxAgentCalls: 20,
  maxConcurrentAgents: 4,
  maxDepth: 64,
  maxTurnsPerAgent: 5,
})
```

Prefer finite limits for workflows that consume remote models or execute code. Use explicit allowlists when capability policy is part of the application's trust boundary.

## Tracing

Attach the dependency-free console tracer while developing:

```tsx
import { AmlRuntime, createConsoleTracer } from "@aml-jsx/sdk"

const runtime = new AmlRuntime()
runtime.on("trace", createConsoleTracer())
```

For production telemetry, supply a trace sink or subscribe to runtime events. Trace-consumer failures should not silently change workflow behavior.

## Deterministic tests

Import test fixtures from the separate testing entry:

```tsx
import { AmlRuntime, Agent } from "@aml-jsx/sdk"
import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"
import { expect, test } from "vitest"

test("passes child output into the parent prompt", async () => {
  const provider = new DeterministicAgentProvider({
    respond(request) {
      if (request.prompt === "inspect") return { text: "finding" }
      return { text: request.prompt }
    },
  })

  const runtime = new AmlRuntime()
  const result = await runtime.evaluate(
    <Agent provider={provider}>
      result:<Agent provider={provider}>inspect</Agent>
    </Agent>
  )

  expect(result).toContain("result:finding")
})
```

Test behavior that can regress:

- Exact prompt and system assembly.
- Authored ordering after parallel work.
- Wait-for-all failure and cleanup behavior inside `<Parallel>`.
- Structured output validation.
- Tool and MCP isolation between sibling Agents.
- Follow-up ordering within one session.
- Sandbox access narrowing and cleanup.
- Workspace persistence and release on success or failure.
- Abort propagation, provider failures, and trace emission.

When implementing a custom provider, use the exported conformance suites from `@aml-jsx/sdk/testing` in addition to focused adapter tests.
