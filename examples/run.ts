import { fileURLToPath } from "node:url"

import { AmlRuntime, createConsoleTracer, type AmlRenderable } from "@aml-jsx/sdk"

interface ExampleModule {
  readonly default: () => AmlRenderable
}

const exampleModules = import.meta.glob<ExampleModule>("./src/{capabilities,core,integrations,resources}/*.tsx")

/**
 * Evaluates one freshly built AML tree with the shared example instrumentation.
 */
export async function evaluateExample(factory: ExampleModule["default"]): Promise<string> {
  const runtime = new AmlRuntime()

  // Every example uses the same public event API an application or tree UI
  // would use; tracing is not a separate execution path.
  runtime.on("trace", createConsoleTracer())
  return await runtime.evaluate(factory())
}

/**
 * Returns every runnable example title in deterministic display order.
 */
export function listExamples(): readonly string[] {
  return Object.keys(exampleModules)
    .map(path => path.slice(path.lastIndexOf("/") + 1, -".tsx".length))
    .sort()
}

/**
 * Loads and evaluates one example by its filename-derived title.
 */
export async function runExample(title: string): Promise<string> {
  const matches = Object.entries(exampleModules).filter(([path]) => path.endsWith(`/${title}.tsx`))

  if (matches.length === 0) {
    throw new TypeError(`Unknown example "${title}". Available examples: ${listExamples().join(", ")}`)
  }

  // Filenames are the public titles, so duplicates across groups would make
  // the CLI ambiguous even though their module paths differ.
  if (matches.length > 1) {
    throw new TypeError(`Example title "${title}" is not unique`)
  }

  const load = matches[0]?.[1]

  if (load === undefined) {
    throw new TypeError(`Example "${title}" could not be loaded`)
  }

  return await evaluateExample((await load()).default)
}

/**
 * Runs the selected example when this module is the vite-node entry point.
 */
async function main(): Promise<void> {
  const title = process.argv[2]

  if (title === undefined) {
    console.log(`Usage: npm run example -- <title>\n\n${listExamples().join("\n")}`)
    return
  }

  console.log(await runExample(title))
}

// Vitest imports the orchestration functions above, so only direct execution
// may consume argv and print to the terminal.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
