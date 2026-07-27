import { execFileSync } from "node:child_process"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { join, resolve } from "node:path"

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
          readonly mcpServers: readonly {
            readonly definition?: { readonly name: string }
            readonly kind: string
            readonly name?: string
          }[]
          readonly output?: {
            readonly jsonSchema: Readonly<Record<string, unknown>>
            readonly type: "json"
          }
          readonly tools: readonly {
            execute?(
              input: unknown,
              context: unknown,
            ): Promise<unknown>
            readonly kind: string
            readonly name: string
          }[]
        },
        context: unknown,
      ): Promise<{ structured?: unknown; text: string }>
    }
    workspaceProvider?: unknown
  }) => {
    evaluate(value: unknown): Promise<string>
  }
  readonly Fragment: unknown
  readonly Mcp: unknown
  readonly Tool: unknown
  readonly Workspace: unknown
  readonly WorkspaceConflictError: {
    is(value: unknown, workspaceId?: string): boolean
    new (workspaceId: string): {
      readonly code: string
      readonly workspaceId: string
    }
  }
  defineWorkspaceProvider(provider: unknown): unknown
  defineMcpServer(options: unknown): unknown
  defineTool(options: unknown): unknown
  evaluate(value: unknown, schema?: unknown): Promise<unknown>
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
const packageJson = JSON.parse(
  readFileSync(resolve(packageDirectory, "package.json"), "utf8"),
) as {
  exports: Record<string, { import: string; types: string }>
  files: string[]
  imports: Record<
    string,
    { "aml-source": string; default: string; types: string }
  >
}

const expectedExports = {
  ".": {
    import: "./dist/index.js",
    types: "./dist/index.d.ts",
  },
  "./jsx-runtime": {
    import: "./dist/jsx-runtime.js",
    types: "./dist/jsx-runtime.d.ts",
  },
  "./jsx-dev-runtime": {
    import: "./dist/jsx-dev-runtime.js",
    types: "./dist/jsx-dev-runtime.d.ts",
  },
  "./testing": {
    import: "./dist/testing.js",
    types: "./dist/testing.d.ts",
  },
}
const expectedImports = {
  "#aml/jsx-dev-runtime": {
    "aml-source": "./src/jsx-dev-runtime.ts",
    types: "./dist/jsx-dev-runtime.d.ts",
    default: "./dist/jsx-dev-runtime.js",
  },
  "#aml/jsx-runtime": {
    "aml-source": "./src/jsx-runtime.ts",
    types: "./dist/jsx-runtime.d.ts",
    default: "./dist/jsx-runtime.js",
  },
}

if (
  Object.keys(packageJson.exports).sort().join("\n") !==
  Object.keys(expectedExports).sort().join("\n")
) {
  throw new Error("SDK exports do not match the reviewed dist-only contract")
}

for (const [name, expected] of Object.entries(expectedExports)) {
  const actual = packageJson.exports[name]

  if (
    actual?.import !== expected.import ||
    actual.types !== expected.types
  ) {
    throw new Error(`SDK export ${name} does not resolve through dist`)
  }
}

if (JSON.stringify(packageJson.imports) !== JSON.stringify(expectedImports)) {
  throw new Error(
    "SDK private JSX imports do not preserve source and dist conditions",
  )
}

if (JSON.stringify(packageJson.files) !== JSON.stringify(["dist"])) {
  throw new Error('SDK package files must be exactly ["dist"]')
}

const resolvedEntries = {
  index: fileURLToPath(import.meta.resolve("@aml/sdk")),
  jsxDevRuntime: fileURLToPath(
    import.meta.resolve("@aml/sdk/jsx-dev-runtime"),
  ),
  jsxRuntime: fileURLToPath(import.meta.resolve("@aml/sdk/jsx-runtime")),
  testing: fileURLToPath(import.meta.resolve("@aml/sdk/testing")),
}

for (const entry of Object.values(resolvedEntries)) {
  if (!entry.startsWith(resolve(packageDirectory, "dist"))) {
    throw new Error(`SDK entry resolved outside dist: ${entry}`)
  }
}

const {
  Agent: publicAgent,
  AmlRuntime,
  defineMcpServer,
  defineWorkspaceProvider,
  evaluate: componentEvaluate,
  Fragment: publicFragment,
  Workspace: publicWorkspace,
  WorkspaceConflictError,
} = (await import(pathToFileURL(resolvedEntries.index).href)) as BuiltSdk
const {
  Fragment: runtimeFragment,
  jsx: runtimeJsx,
} = (await import(
  pathToFileURL(resolvedEntries.jsxRuntime).href
)) as BuiltJsxRuntime
const {
  DeterministicAgentProvider,
  DeterministicWorkspaceProvider,
  agentProviderConformance,
  workspaceProviderConformance,
} = (await import(
  pathToFileURL(resolvedEntries.testing).href
)) as BuiltTesting

if (publicFragment !== runtimeFragment) {
  throw new Error("SDK root and JSX runtime export different Fragments")
}

const builtOutput = await new AmlRuntime().evaluate(
  runtimeJsx(runtimeFragment, {
    children: ["built ", runtimeJsx(() => Promise.resolve("runtime"), {})],
  }),
)

if (builtOutput !== "built runtime") {
  throw new Error(`Unexpected built SDK output: ${builtOutput}`)
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
      typeof value === "object" &&
      value !== null &&
      typeof Reflect.get(value, "answer") === "number"
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
      if (
        request.output?.type !== "json" ||
        Reflect.get(
          request.output.jsonSchema,
          "type",
        ) !== "object"
      ) {
        throw new Error(
          "Built SDK omitted its structured output declaration",
        )
      }

      return { structured: { answer: 42 }, text: "" }
    },
  },
}).evaluate(
  runtimeJsx(async () => {
    const answer = await componentEvaluate(
      runtimeJsx(publicAgent, { children: "Return an answer." }),
      modelSchema,
    )
    return `answer:${String(answer)}`
  }, {}),
)

if (structuredOutput !== "answer:42") {
  throw new Error(
    `Unexpected built SDK structured output: ${structuredOutput}`,
  )
}

const deterministicProvider = new DeterministicAgentProvider()
await agentProviderConformance(deterministicProvider)

if (deterministicProvider.calls.length !== 1) {
  throw new Error("SDK testing entry point did not exercise its provider")
}

await workspaceProviderConformance(
  new DeterministicWorkspaceProvider(),
)
const deterministicWorkspaceProvider =
  new DeterministicWorkspaceProvider()
const definedWorkspaceProvider = defineWorkspaceProvider(
  deterministicWorkspaceProvider,
)

if (
  definedWorkspaceProvider !== deterministicWorkspaceProvider ||
  !Object.isFrozen(definedWorkspaceProvider)
) {
  throw new Error(
    "SDK dist defineWorkspaceProvider contract is invalid",
  )
}

const conflict = new WorkspaceConflictError("package-check")

if (
  conflict.code !== "AML_WORKSPACE_CONFLICT" ||
  conflict.workspaceId !== "package-check" ||
  !WorkspaceConflictError.is(conflict, "package-check")
) {
  throw new Error(
    "SDK dist WorkspaceConflictError contract is invalid",
  )
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
  }),
)

if (
  workspaceOutput !== "built Workspace" ||
  deterministicWorkspaceProvider.saves.length !== 1 ||
  deterministicWorkspaceProvider.releases.length !== 1
) {
  throw new Error(
    "SDK dist Workspace lifecycle or testing export is invalid",
  )
}

// Compile and execute one tree across two physical SDK copies. Runtime brands
// must support dispatch without making the public AmlNode type nominal.
const copyFixtureDirectory = mkdtempSync(join(tmpdir(), "aml-sdk-copies-"))

try {
  const copyDirectories = {
    a: join(copyFixtureDirectory, "node_modules/@aml/sdk-a"),
    b: join(copyFixtureDirectory, "node_modules/@aml/sdk-b"),
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
        name: `@aml/sdk-${copy}`,
        type: "module",
        version: "0.0.0",
      }),
    )
  }

  const standardSchemaDirectory = join(
    copyFixtureDirectory,
    "node_modules/@standard-schema/spec",
  )
  mkdirSync(standardSchemaDirectory, { recursive: true })
  cpSync(
    resolve(packageDirectory, "../../node_modules/@standard-schema/spec"),
    standardSchemaDirectory,
    { recursive: true },
  )

  writeFileSync(
    join(copyFixtureDirectory, "consumer.mts"),
    [
      'import { AmlRuntime, type AmlRenderable } from "@aml/sdk-a"',
      'import type { McpProps, ToolProps } from "@aml/sdk-a"',
      'import { defineMcpServer, defineTool, evaluate } from "@aml/sdk-b"',
      'import { jsx } from "@aml/sdk-b/jsx-runtime"',
      "",
      'const foreignNode = jsx(() => "cross-copy", {})',
      "const renderable: AmlRenderable = foreignNode",
      "await new AmlRuntime().evaluate(renderable)",
      "await new AmlRuntime().evaluate(",
      '  jsx(async () => `nested:${await evaluate("data")}`, {}),',
      ")",
      "",
      "const schema = {",
      '  "~standard": {',
      "    jsonSchema: { input: () => ({ type: \"object\" }) },",
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
    ].join("\n"),
  )
  writeFileSync(
    join(copyFixtureDirectory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2022",
      },
      files: ["consumer.mts"],
    }),
  )

  execFileSync(
    process.execPath,
    [
      resolve(packageDirectory, "../../node_modules/typescript/bin/tsc"),
      "--project",
      join(copyFixtureDirectory, "tsconfig.json"),
    ],
    { stdio: "pipe" },
  )

  const copyA = (await import(
    pathToFileURL(join(copyDirectories.a, "dist/index.js")).href
  )) as BuiltSdk
  const copyB = (await import(
    pathToFileURL(join(copyDirectories.b, "dist/jsx-runtime.js")).href
  )) as BuiltJsxRuntime
  const copyBPackage = (await import(
    pathToFileURL(join(copyDirectories.b, "dist/index.js")).href
  )) as BuiltSdk
  const crossCopyOutput = await new copyA.AmlRuntime().evaluate(
    copyB.jsx(() => "cross-copy", {}),
  )

  if (crossCopyOutput !== "cross-copy") {
    throw new Error(`Unexpected cross-copy output: ${crossCopyOutput}`)
  }

  const crossCopyNestedOutput = await new copyA.AmlRuntime().evaluate(
    copyB.jsx(
      async () =>
        `nested:${String(await copyBPackage.evaluate("data"))}`,
      {},
    ),
  )

  if (crossCopyNestedOutput !== "nested:data") {
    throw new Error(
      `Unexpected cross-copy nested output: ${crossCopyNestedOutput}`,
    )
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
        typeof value === "object" &&
        value !== null &&
        typeof Reflect.get(value, "id") === "number"
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
      children: [
        copyB.jsx(copyBPackage.Tool, { use: foreignTool }),
        "Use the Tool.",
      ],
    }),
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
        const name =
          server?.kind === "named"
            ? server.name
            : server?.definition?.name

        return { text: name ?? "missing" }
      },
    },
  }).evaluate(
    copyB.jsx(copyBPackage.Agent, {
      children: copyB.jsx(copyBPackage.Mcp, { use: foreignMcp }),
    }),
  )

  if (mcpOutput !== "cross_copy_mcp") {
    throw new Error(`Unexpected cross-copy MCP output: ${mcpOutput}`)
  }
} finally {
  rmSync(copyFixtureDirectory, { force: true, recursive: true })
}

const packOutput = execFileSync(
  "npm",
  ["pack", "--dry-run", "--ignore-scripts", "--json"],
  {
    cwd: packageDirectory,
    encoding: "utf8",
  },
)
const [packResult] = JSON.parse(packOutput) as PackResult[]
const packedFiles = new Set(packResult?.files.map((file) => file.path))

for (const expectedFile of [
  "dist/index.d.ts",
  "dist/index.js",
  "dist/jsx-dev-runtime.d.ts",
  "dist/jsx-dev-runtime.js",
  "dist/jsx-runtime.d.ts",
  "dist/jsx-runtime.js",
  "dist/testing.d.ts",
  "dist/testing.js",
]) {
  if (!packedFiles.has(expectedFile)) {
    throw new Error(`SDK package is missing ${expectedFile}`)
  }
}

console.log("SDK dist runtime, exports, and packed files are valid")
