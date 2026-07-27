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
      ): Promise<{ text: string }>
    }
  }) => {
    evaluate(value: unknown): Promise<string>
  }
  readonly Fragment: unknown
  readonly Tool: unknown
  defineTool(options: unknown): unknown
}

interface BuiltJsxRuntime {
  readonly Fragment: unknown
  jsx(type: unknown, props: Record<string, unknown>): unknown
}

interface BuiltTesting {
  readonly DeterministicAgentProvider: new () => {
    readonly calls: readonly unknown[]
  }
  agentProviderConformance(provider: unknown): Promise<void>
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

const { AmlRuntime, Fragment: publicFragment } = (await import(
  pathToFileURL(resolvedEntries.index).href
)) as BuiltSdk
const {
  Fragment: runtimeFragment,
  jsx: runtimeJsx,
} = (await import(
  pathToFileURL(resolvedEntries.jsxRuntime).href
)) as BuiltJsxRuntime
const {
  DeterministicAgentProvider,
  agentProviderConformance,
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

const deterministicProvider = new DeterministicAgentProvider()
await agentProviderConformance(deterministicProvider)

if (deterministicProvider.calls.length !== 1) {
  throw new Error("SDK testing entry point did not exercise its provider")
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
      'import type { ToolProps } from "@aml/sdk-a"',
      'import { defineTool } from "@aml/sdk-b"',
      'import { jsx } from "@aml/sdk-b/jsx-runtime"',
      "",
      'const foreignNode = jsx(() => "cross-copy", {})',
      "const renderable: AmlRenderable = foreignNode",
      "await new AmlRuntime().evaluate(renderable)",
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
