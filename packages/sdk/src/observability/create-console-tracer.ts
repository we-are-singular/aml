import type {
  AmlTraceAttribute,
  AmlTraceEvent,
} from "./trace-event.js"
import type { TraceSink } from "./trace-sink.js"

/**
 * Console tracer configuration.
 */
export interface ConsoleTracerOptions {
  /**
   * Includes prompt and output fields explicitly marked sensitive by AML.
   */
  readonly captureContent?: boolean

  /**
   * Replaces console.log for deterministic tests and custom terminals.
   */
  readonly write?: (line: string) => void
}

/**
 * Creates a compact tree-oriented trace consumer for local development.
 */
export function createConsoleTracer(
  options: ConsoleTracerOptions = {},
): TraceSink {
  const captureContent = options.captureContent ?? false
  const write = options.write ?? ((line: string) => console.log(line))

  if (typeof captureContent !== "boolean") {
    throw new TypeError(
      "createConsoleTracer captureContent must be a boolean",
    )
  }

  if (typeof write !== "function") {
    throw new TypeError(
      "createConsoleTracer write must be a function",
    )
  }

  const runs = new Map<string, Map<string, number>>()
  const sink = ((event: AmlTraceEvent) => {
    const depths = runs.get(event.runId) ?? new Map<string, number>()
    runs.set(event.runId, depths)
    const depth =
      event.parentSpanId === undefined
        ? 0
        : (depths.get(event.parentSpanId) ?? 0) + 1
    depths.set(event.spanId, depth)

    const indent = "  ".repeat(depth)
    const attributes = formatAttributes(event.attributes)
    let line: string

    if (event.type === "span.start") {
      line = `${indent}▶ ${event.kind} ${event.name}${attributes}`
    } else if (event.type === "span.end") {
      const marker = event.status === "ok" ? "✓" : "✗"
      line = `${indent}${marker} ${event.kind} ${event.name} ${formatDuration(event.durationMs)}${attributes}`
    } else {
      line = `${indent}• ${event.name}${attributes}`
    }

    let result: unknown

    try {
      result = Reflect.apply(write, undefined, [line])
    } finally {
      // Evaluation completion is the last event in one run. Cleanup belongs in
      // finally because a custom writer may throw on the terminal line.
      if (
        event.type === "span.end" &&
        event.kind === "evaluation"
      ) {
        runs.delete(event.runId)
      }
    }

    // Forward a non-void writer result so the evaluation dispatcher applies
    // the same synchronous-consumer contract and rejection handling.
    return result
  }) as TraceSink

  // The dispatcher captures this flag once when AmlRuntime is constructed.
  Object.defineProperty(sink, "captureContent", {
    configurable: false,
    enumerable: true,
    value: captureContent,
    writable: false,
  })

  return Object.freeze(sink)
}

/**
 * Produces one stable metadata suffix without terminal-specific color codes.
 */
function formatAttributes(
  attributes: Readonly<Record<string, AmlTraceAttribute>>,
): string {
  const entries = Object.entries(attributes)

  if (entries.length === 0) {
    return ""
  }

  return ` ${entries
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ")}`
}

/**
 * Keeps short spans readable while retaining sub-millisecond timing.
 */
function formatDuration(durationMs: number): string {
  return durationMs < 10
    ? `${durationMs.toFixed(1)}ms`
    : `${Math.round(durationMs)}ms`
}
