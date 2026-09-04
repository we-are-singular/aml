import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join, resolve } from "node:path"

interface PackFile {
  path: string
}

interface PackResult {
  files: PackFile[]
}

interface BuiltSdk {
  readonly Agent: unknown
  readonly AmlRuntime: new (options?: {
    agentProvider?: {
      readonly name: string
      run(
        request: {
          readonly followUps?: readonly string[]
          readonly mcpServers: readonly {
            readonly definition?: { readonly name: string }
            readonly kind: string
            readonly name?: string
          }[]
          readonly output?: {
            readonly jsonSchema: Readonly<Record<string, unknown>>
            readonly type: "json"
          }
          readonly prompt: string
          readonly tools: readonly {
            execute?(input: unknown, context: unknown): Promise<unknown>
            readonly kind: string
            readonly name: string
          }[]
        },
        context: unknown
      ): Promise<{ structured?: unknown; text: string }>
    }
    workspaceProvider?: unknown
  }) => {
    evaluate(value: unknown): Promise<string>
  }
  readonly File: unknown
  readonly Fragment: unknown
  readonly FollowUp: unknown
  readonly Loop: unknown
  readonly Mcp: unknown
  readonly Script: unknown
  readonly Tool: unknown
  readonly Workspace: unknown
  readonly codexAgent: unknown
  readonly daytonaSandbox: unknown
  readonly dockerSandbox: unknown
  readonly filesystemWorkspace: unknown
  readonly glmAgent: unknown
  readonly localSandbox: unknown
  readonly localWorkspace: unknown
  readonly s3Workspace: unknown
  readonly modalSandbox: unknown
  readonly opencodeAgent: unknown
  readonly piAgent: unknown
  readonly WorkspaceConflictError: {
    is(value: unknown, workspaceId?: string): boolean
    new (workspaceId: string): {
      readonly code: string
      readonly workspaceId: string
    }
  }
  createContext<Value>(
    name: string,
    defaultValue?: Value
  ): {
    readonly name: string
    readonly Provider: unknown
  }
  defineWorkspaceProvider(provider: unknown): unknown
  defineMcpServer(options: unknown): unknown
  defineTool(options: unknown): unknown
  evaluate(value: unknown, schema?: unknown): Promise<unknown>
  useContext<Value>(context: unknown): Value
}

interface BuiltJsxRuntime {
  readonly Fragment: unknown
  jsx(type: unknown, props: Record<string, unknown>): unknown
}

interface BuiltTesting {
  readonly DeterministicAgentProvider: new () => {
    readonly calls: readonly unknown[]
  }
  readonly DeterministicWorkspaceProvider: new () => {
    readonly releases: readonly string[]
    readonly saves: readonly string[]
  }
  agentProviderConformance(provider: unknown): Promise<void>
  workspaceProviderConformance(provider: unknown): Promise<void>
}

const packageDirectory = resolve(import.meta.dirname, "..")
const packageJson = JSON.parse(readFileSync(resolve(packageDirectory, "package.json"), "utf8")) as {
  exports: Record<string, { import: string; types: string }>
  files: string[]
  imports: Record<string, { "aml-source": string; default: string; types: string }>
}

const expectedExports = {
  ".": {
    import: "./dist/index.js",
    types: "./dist/sdk/src/index.d.ts",
  },
  "./jsx-runtime": {
    import: "./dist/jsx-runtime.js",
    types: "./dist/sdk/src/jsx-runtime.d.ts",
  },
  "./jsx-dev-runtime": {
    import: "./dist/jsx-dev-runtime.js",
    types: "./dist/sdk/src/jsx-dev-runtime.d.ts",
  },
  "./testing": {
    import: "./dist/testing.js",
    types: "./dist/sdk/src/testing.d.ts",
  },
}
const expectedImports = {
  "#aml/jsx-dev-runtime": {
    "aml-source": "./src/jsx-dev-runtime.ts",
    types: "./dist/sdk/src/jsx-dev-runtime.d.ts",
    default: "./dist/jsx-dev-runtime.js",
  },
  "#aml/jsx-runtime": {
    "aml-source": "./src/jsx-runtime.ts",
    types: "./dist/sdk/src/jsx-runtime.d.ts",
    default: "./dist/jsx-runtime.js",
  },
}

if (Object.keys(packageJson.exports).sort().join("\n") !== Object.keys(expectedExports).sort().join("\n")) {
  throw new Error("SDK exports do not match the reviewed dist-only contract")
}

for (const [name, expected] of Object.entries(expectedExports)) {
  const actual = packageJson.exports[name]

  if (actual?.import !== expected.import || actual.types !== expected.types) {
    throw new Error(`SDK export ${name} does not resolve through dist`)
  }
}

if (JSON.stringify(packageJson.imports) !== JSON.stringify(expectedImports)) {
  throw new Error("SDK private JSX imports do not preserve source and dist conditions")
}

if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist"])) {
  throw new Error('SDK package files must be exactly ["dist"]')
}

const resolvedEntries = {
  index: fileURLToPath(import.meta.resolve("@aml-jsx/sdk")),
  jsxDevRuntime: fileURLToPath(import.meta.resolve("@aml-jsx/sdk/jsx-dev-runtime")),
  jsxRuntime: fileURLToPath(import.meta.resolve("@aml-jsx/sdk/jsx-runtime")),
  testing: fileURLToPath(import.meta.resolve("@aml-jsx/sdk/testing")),
}

for (const entry of Object.values(resolvedEntries)) {
  if (!entry.startsWith(resolve(packageDirectory, "dist"))) {
    throw new Error(`SDK entry resolved outside dist: ${entry}`)
  }
}

const builtSdk = await import(pathToFileURL(resolvedEntries.index).href)

if ("AML" in builtSdk) {
  throw new Error("The type-only AML authoring namespace must not add a runtime export")
}

const {
  Agent: publicAgent,
  AmlRuntime,
  codexAgent,
  daytonaSandbox,
  defineMcpServer,
  defineWorkspaceProvider,
  dockerSandbox,
  filesystemWorkspace,
  glmAgent,
  evaluate: componentEvaluate,
  File: publicFile,
  Fragment: publicFragment,
  FollowUp: publicFollowUp,
  localWorkspace,
  s3Workspace,
  localSandbox,
  Loop: publicLoop,
  modalSandbox,
  opencodeAgent,
  piAgent,
  Script: publicScript,
  Workspace: publicWorkspace,
  WorkspaceConflictError,
} = builtSdk as BuiltSdk
const { Fragment: runtimeFragment, jsx: runtimeJsx } = (await import(
  pathToFileURL(resolvedEntries.jsxRuntime).href
)) as BuiltJsxRuntime
const {
  DeterministicAgentProvider,
  DeterministicWorkspaceProvider,
  agentProviderConformance,
  workspaceProviderConformance,
} = (await import(pathToFileURL(resolvedEntries.testing).href)) as BuiltTesting

if (
  typeof codexAgent !== "function" ||
  typeof glmAgent !== "function" ||
  typeof opencodeAgent !== "function" ||
  typeof piAgent !== "function" ||
  typeof daytonaSandbox !== "function" ||
  typeof dockerSandbox !== "function" ||
  typeof filesystemWorkspace !== "function" ||
  typeof localSandbox !== "function" ||
  typeof modalSandbox !== "function" ||
  typeof localWorkspace !== "function" ||
  typeof s3Workspace !== "function" ||
  typeof publicFile !== "function" ||
  typeof publicScript !== "function"
) {
  throw new Error("SDK root does not expose its configured providers and filesystem primitives")
}

if (publicFragment !== runtimeFragment) {
  throw new Error("SDK root and JSX runtime export different Fragments")
}

const builtOutput = await new AmlRuntime().evaluate(
  runtimeJsx(runtimeFragment, {
    children: ["built ", runtimeJsx(() => Promise.resolve("runtime"), {})],
  })
)

if (builtOutput !== "built runtime") {
  throw new Error(`Unexpected built SDK output: ${builtOutput}`)
}

const followUpOutput = await new AmlRuntime({
  agentProvider: {
    name: "follow-up-package-check",
    async run(request) {
      if (!Array.isArray(request.followUps) || request.followUps.join("|") !== "challenge|final") {
        throw new Error("Built SDK omitted its FollowUp turn plan")
      }

      return { text: request.followUps.at(-1) ?? request.prompt }
    },
  },
}).evaluate(
  runtimeJsx(publicAgent, {
    children: [
      "initial",
      runtimeJsx(publicFollowUp, { children: "challenge" }),
      runtimeJsx(publicFollowUp, { children: "final" }),
    ],
  })
)

if (followUpOutput !== "final") {
  throw new Error(`Unexpected built SDK FollowUp output: ${followUpOutput}`)
}

const loopSchema = {
  "~standard": {
    validate: (value: unknown) => {
      const status = typeof value === "object" && value !== null ? Reflect.get(value, "status") : undefined

      return status === "pending" || status === "complete"
        ? { value: { status } }
        : { issues: [{ message: "invalid status" }] }
    },
    vendor: "package-check",
    version: 1,
  },
}
const loopPrompts: string[] = []
const loopOutput = await new AmlRuntime({
  agentProvider: {
    name: "loop-package-check",
    async run(request, context) {
      loopPrompts.push(request.prompt)

      if (request.prompt === "pending") {
        const stateTool = request.tools.find(tool => tool.kind === "javascript" && tool.name === "aml_set_state")

        if (!stateTool?.execute) {
          throw new Error("Built SDK Loop omitted its state capability")
        }

        await stateTool.execute({ updates: { status: "complete" } }, context)
        return { text: "stale" }
      }

      return { text: "current" }
    },
  },
}).evaluate(
  runtimeJsx(publicLoop, {
    initial: { status: "pending" },
    render: ({ state }: { state: { readonly status: string } }) =>
      runtimeJsx(publicAgent, {
        children: state.status,
      }),
    schema: loopSchema,
  })
)

if (loopOutput !== "current" || loopPrompts.join("|") !== "pending|complete") {
  throw new Error("Built SDK Loop did not commit into a fresh Agent session")
}

const modelSchema = {
  "~standard": {
    jsonSchema: {
      input: () => ({
        properties: { answer: { type: "number" } },
        required: ["answer"],
        type: "object",
      }),
    },
    validate: (value: unknown) =>
      typeof value === "object" && value !== null && typeof Reflect.get(value, "answer") === "number"
        ? { value: Reflect.get(value, "answer") }
        : { issues: [{ message: "answer must be a number" }] },
    vendor: "package-check",
    version: 1,
  },
}
const structuredOutput = await new AmlRuntime({
  agentProvider: {
    name: "structured-package-check",
    async run(request) {
      if (request.output?.type !== "json" || Reflect.get(request.output.jsonSchema, "type") !== "object") {
        throw new Error("Built SDK omitted its structured output declaration")
      }

      return { structured: { answer: 42 }, text: "" }
    },
  },
}).evaluate(
  runtimeJsx(async () => {
    const answer = await componentEvaluate(runtimeJsx(publicAgent, { children: "Return an answer." }), modelSchema)
    return `answer:${String(answer)}`
  }, {})
)

if (structuredOutput !== "answer:42") {
  throw new Error(`Unexpected built SDK structured output: ${structuredOutput}`)
}

const deterministicProvider = new DeterministicAgentProvider()
await agentProviderConformance(deterministicProvider)

if (deterministicProvider.calls.length !== 1) {
  throw new Error("SDK testing entry point did not exercise its provider")
}

await workspaceProviderConformance(new DeterministicWorkspaceProvider())
const deterministicWorkspaceProvider = new DeterministicWorkspaceProvider()
const definedWorkspaceProvider = defineWorkspaceProvider(deterministicWorkspaceProvider)

if (definedWorkspaceProvider !== deterministicWorkspaceProvider || !Object.isFrozen(definedWorkspaceProvider)) {
  throw new Error("SDK dist defineWorkspaceProvider contract is invalid")
}

const conflict = new WorkspaceConflictError("package-check")

if (
  conflict.code !== "AML_WORKSPACE_CONFLICT" ||
  conflict.workspaceId !== "package-check" ||
  !WorkspaceConflictError.is(conflict, "package-check")
) {
  throw new Error("SDK dist WorkspaceConflictError contract is invalid")
}

const definedMcpServer = defineMcpServer({
  name: "package-check",
  transport: {
    type: "streamable-http",
    url: "https://example.com/mcp",
  },
}) as {
  readonly name: string
  readonly transport: Readonly<{ readonly url: string }>
}

if (
  !Object.isFrozen(definedMcpServer) ||
  !Object.isFrozen(definedMcpServer.transport) ||
  definedMcpServer.transport.url !== "https://example.com/mcp"
) {
  throw new Error("SDK dist defineMcpServer contract is invalid")
}

const workspaceOutput = await new AmlRuntime({
  workspaceProvider: definedWorkspaceProvider,
}).evaluate(
  runtimeJsx(publicWorkspace, {
    children: "built Workspace",
    id: "package-check",
    save: true,
  })
)

if (
  workspaceOutput !== "built Workspace" ||
  deterministicWorkspaceProvider.saves.length !== 1 ||
  deterministicWorkspaceProvider.releases.length !== 1
) {
  throw new Error("SDK dist Workspace lifecycle or testing export is invalid")
}

// Compile and execute one tree across two physical SDK copies. Runtime brands
// must support dispatch without making the public AmlNode type nominal.
const copyFixtureDirectory = mkdtempSync(join(tmpdir(), "aml-sdk-copies-"))

try {
  const copyDirectories = {
    a: join(copyFixtureDirectory, "node_modules/@aml-jsx/sdk-a"),
    b: join(copyFixtureDirectory, "node_modules/@aml-jsx/sdk-b"),
  }

  for (const [copy, directory] of Object.entries(copyDirectories)) {
    mkdirSync(directory, { recursive: true })
    cpSync(resolve(packageDirectory, "dist"), join(directory, "dist"), {
      recursive: true,
    })
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        exports: packageJson.exports,
        name: `@aml-jsx/sdk-${copy}`,
        type: "module",
        version: "0.0.0",
      })
    )
  }

  for (const dependency of [
    "@agentclientprotocol/sdk",
    "@aws-sdk/client-s3",
    "@daytona/sdk",
    "@modelcontextprotocol/sdk",
    "@opencode-ai/sdk",
    "@standard-schema/spec",
    "execa",
    "globby",
    "modal",
    "proper-lockfile",
    "tar",
    "typebox",
  ]) {
    const fixtureDependency = join(copyFixtureDirectory, "node_modules", dependency)
    mkdirSync(dirname(fixtureDependency), { recursive: true })
    symlinkSync(resolve(packageDirectory, "../node_modules", dependency), fixtureDependency, "dir")
  }

  writeFileSync(
    join(copyFixtureDirectory, "consumer.mts"),
    [
      'import { AmlRuntime, type AML, type AmlRenderable } from "@aml-jsx/sdk-a"',
      'import type { McpProps, ToolProps } from "@aml-jsx/sdk-a"',
      'import { defineMcpServer, defineTool, evaluate } from "@aml-jsx/sdk-b"',
      'import { createContext, useContext } from "@aml-jsx/sdk-b"',
      'import { jsx } from "@aml-jsx/sdk-b/jsx-runtime"',
      "",
      'const foreignNode = jsx(() => "cross-copy", {})',
      "const renderable: AmlRenderable = foreignNode",
      "await new AmlRuntime().evaluate(renderable)",
      "type WrappedProps = AML.PropsWithRequiredChildren<{ readonly prefix: string }>",
      "const Wrapped: AML.Component<WrappedProps> = ({ children, prefix }) => [prefix, children]",
      'const authored: AML = jsx(Wrapped, { children: foreignNode, prefix: "typed:" })',
      "const authoredOutput = await new AmlRuntime().evaluate(authored)",
      'if (authoredOutput !== "typed:cross-copy") throw new Error("Packaged AML authoring types are invalid")',
      "await new AmlRuntime().evaluate(",
      '  jsx(async () => `nested:${await evaluate("data")}`, {}),',
      ")",
      'const CrossCopyContext = createContext<string>("CrossCopy")',
      "await new AmlRuntime().evaluate(",
      "  jsx(CrossCopyContext.Provider, {",
      '    value: "cross-copy-context",',
      "    children: jsx(() => useContext(CrossCopyContext), {}),",
      "  }),",
      ")",
      "",
      "const schema = {",
      '  "~standard": {',
      '    jsonSchema: { input: () => ({ type: "object" }) },',
      "    validate: (value: unknown) => ({ value }),",
      '    vendor: "fixture",',
      "    version: 1 as const,",
      "  },",
      "} as any",
      "const foreignTool = defineTool({",
      '  description: "Cross-copy Tool",',
      "  execute: (input: any) => input.id,",
      "  input: schema,",
      '  name: "cross_copy",',
      "})",
      "const toolProps: ToolProps = { use: foreignTool }",
      "void toolProps",
      "const foreignMcp = defineMcpServer({",
      '  name: "cross_copy_mcp",',
      "  transport: {",
      '    type: "streamable-http",',
      '    url: "https://example.com/mcp",',
      "  },",
      "})",
      "const mcpProps: McpProps = { use: foreignMcp }",
      "void mcpProps",
      "",
    ].join("\n")
  )
  writeFileSync(
    join(copyFixtureDirectory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2022",
      },
      files: ["consumer.mts"],
    })
  )

  execFileSync(
    process.execPath,
    [
      resolve(packageDirectory, "../node_modules/typescript/bin/tsc"),
      "--project",
      join(copyFixtureDirectory, "tsconfig.json"),
    ],
    { stdio: "inherit" }
  )

  const copyA = (await import(pathToFileURL(join(copyDirectories.a, "dist/index.js")).href)) as BuiltSdk
  const copyB = (await import(pathToFileURL(join(copyDirectories.b, "dist/jsx-runtime.js")).href)) as BuiltJsxRuntime
  const copyBPackage = (await import(pathToFileURL(join(copyDirectories.b, "dist/index.js")).href)) as BuiltSdk
  const crossCopyOutput = await new copyA.AmlRuntime().evaluate(copyB.jsx(() => "cross-copy", {}))

  if (crossCopyOutput !== "cross-copy") {
    throw new Error(`Unexpected cross-copy output: ${crossCopyOutput}`)
  }

  const crossCopyNestedOutput = await new copyA.AmlRuntime().evaluate(
    copyB.jsx(async () => `nested:${String(await copyBPackage.evaluate("data"))}`, {})
  )

  if (crossCopyNestedOutput !== "nested:data") {
    throw new Error(`Unexpected cross-copy nested output: ${crossCopyNestedOutput}`)
  }

  // Context uses the same realm-wide exact-identity contract as AML nodes.
  // The Provider and useContext() may come from copy B while copy A owns the
  // evaluator and active component invocation.
  const crossCopyContext = copyBPackage.createContext<string>("CrossCopy")
  const crossCopyContextOutput = await new copyA.AmlRuntime().evaluate(
    copyB.jsx(crossCopyContext.Provider, {
      children: copyB.jsx(() => copyBPackage.useContext<string>(crossCopyContext), {}),
      value: "cross-copy-context",
    })
  )

  if (crossCopyContextOutput !== "cross-copy-context") {
    throw new Error(`Unexpected cross-copy Context output: ${crossCopyContextOutput}`)
  }

  // Tool authenticity uses a global exact-identity registry. Prove a Tool
  // created by copy B keeps its validated execution port in copy A.
  const schema = {
    "~standard": {
      jsonSchema: {
        input: () => ({
          properties: { id: { type: "number" } },
          required: ["id"],
          type: "object",
        }),
      },
      validate: (value: unknown) =>
        typeof value === "object" && value !== null && typeof Reflect.get(value, "id") === "number"
          ? { value }
          : { issues: [{ message: "id must be a number" }] },
      vendor: "package-check",
      version: 1,
    },
  }
  const foreignTool = copyBPackage.defineTool({
    description: "Read one cross-copy ID",
    execute: (input: { id: number }) => input.id,
    input: schema,
    name: "cross_copy",
  })
  const toolOutput = await new copyA.AmlRuntime({
    agentProvider: {
      name: "cross-copy-provider",
      async run(request, context) {
        const [tool] = request.tools

        if (tool?.kind !== "javascript" || !tool.execute) {
          throw new Error("Cross-copy Tool did not reach the provider")
        }

        return {
          text: String(await tool.execute({ id: 42 }, context)),
        }
      },
    },
  }).evaluate(
    copyB.jsx(copyBPackage.Agent, {
      children: [copyB.jsx(copyBPackage.Tool, { use: foreignTool }), "Use the Tool."],
    })
  )

  if (toolOutput !== "42") {
    throw new Error(`Unexpected cross-copy Tool output: ${toolOutput}`)
  }

  // MCP authenticity uses the same global exact-identity pattern without
  // exposing registration state to application code.
  const foreignMcp = copyBPackage.defineMcpServer({
    name: "cross_copy_mcp",
    transport: {
      type: "streamable-http",
      url: "https://example.com/mcp",
    },
  })
  const mcpOutput = await new copyA.AmlRuntime({
    agentProvider: {
      name: "cross-copy-mcp-provider",
      async run(request) {
        const [server] = request.mcpServers
        const name = server?.kind === "named" ? server.name : server?.definition?.name

        return { text: name ?? "missing" }
      },
    },
  }).evaluate(
    copyB.jsx(copyBPackage.Agent, {
      children: copyB.jsx(copyBPackage.Mcp, { use: foreignMcp }),
    })
  )

  if (mcpOutput !== "cross_copy_mcp") {
    throw new Error(`Unexpected cross-copy MCP output: ${mcpOutput}`)
  }

  // Primitive dispatch is also realm-wide. A Loop authored by copy B must be
  // intercepted by copy A instead of invoking its sentinel component body.
  const crossCopyLoopPrompts: string[] = []
  const crossCopyLoopOutput = await new copyA.AmlRuntime({
    agentProvider: {
      name: "cross-copy-loop-provider",
      async run(request, context) {
        crossCopyLoopPrompts.push(request.prompt)

        if (request.prompt === "pending") {
          const stateTool = request.tools.find(tool => tool.kind === "javascript" && tool.name === "aml_set_state")

          if (!stateTool?.execute) {
            throw new Error("Cross-copy Loop omitted its state capability")
          }

          await stateTool.execute({ updates: { status: "complete" } }, context)
          return { text: "stale" }
        }

        return { text: "cross-copy-current" }
      },
    },
  }).evaluate(
    copyB.jsx(copyBPackage.Loop, {
      initial: { status: "pending" },
      render: ({ state }: { state: { readonly status: string } }) =>
        copyB.jsx(copyBPackage.Agent, {
          children: state.status,
        }),
      schema: loopSchema,
    })
  )

  if (crossCopyLoopOutput !== "cross-copy-current" || crossCopyLoopPrompts.join("|") !== "pending|complete") {
    throw new Error("Cross-copy Loop did not retain primitive and state semantics")
  }
} finally {
  rmSync(copyFixtureDirectory, { force: true, recursive: true })
}

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: packageDirectory,
  encoding: "utf8",
})
// npm pack --json returns an array of one element; npm 12 changes this shape.
const [packResult] = JSON.parse(packOutput) as PackResult[]
const packedFiles = new Set(packResult?.files.map(file => file.path))

for (const expectedFile of [
  "dist/index.js",
  "dist/jsx-dev-runtime.js",
  "dist/jsx-runtime.js",
  "dist/providers/agents/codex/src/index.d.ts",
  "dist/providers/agents/opencode/src/index.d.ts",
  "dist/providers/agents/pi/src/index.d.ts",
  "dist/providers/sandboxes/docker/src/index.d.ts",
  "dist/providers/workspaces/local/src/index.d.ts",
  "dist/sdk/src/index.d.ts",
  "dist/sdk/src/jsx-dev-runtime.d.ts",
  "dist/sdk/src/jsx-runtime.d.ts",
  "dist/sdk/src/testing.d.ts",
  "dist/testing.js",
]) {
  if (!packedFiles.has(expectedFile)) {
    throw new Error(`SDK package is missing ${expectedFile}`)
  }
}

console.log("SDK dist runtime, exports, and packed files are valid")
