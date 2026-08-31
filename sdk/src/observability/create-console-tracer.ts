import type { AmlTraceAttribute, AmlTraceEvent } from "./trace-event.js"
import type { TraceSink } from "./trace-sink.js"

/**
 * Configuration for {@link createConsoleTracer}.
 */
export interface ConsoleTracerOptions {
  /**
   * Whether trace attributes may include prompts, output, error messages, and
   * other fields explicitly marked sensitive by AML.
   *
   * Defaults to `false`. Enable only when the destination is approved to retain
   * model-facing or application content.
   */
  readonly captureContent?: boolean

  /**
   * Writes one already-formatted trace line.
   *
   * Defaults to `console.log`. A returned promise is observed through the
   * runtime's trace-error channel but is never awaited by workflow execution.
   */
  readonly write?: (line: string) => unknown
}

/**
 * Creates a dependency-free, tree-oriented {@link TraceSink} for local
 * development and terminal logs.
 *
 * The sink indents events by span ancestry, prints lifecycle markers and
 * attributes without terminal color codes, and releases per-run state when the
 * evaluation span ends. High-volume ACP message, thought, and tool-update
 * chunks are omitted from this view; they remain available to other sinks.
 *
 * @param options Content policy and output destination. Both are captured once.
 */
export function createConsoleTracer(options: ConsoleTracerOptions = {}): TraceSink {
  const captureContent = options.captureContent ?? false
  const write = options.write ?? ((line: string) => console.log(line))

  if (typeof captureContent !== "boolean") {
    throw new TypeError("createConsoleTracer captureContent must be a boolean")
  }

  if (typeof write !== "function") {
    throw new TypeError("createConsoleTracer write must be a function")
  }

  const runs = new Map<string, Map<string, number>>()
  const sink = ((event: AmlTraceEvent) => {
    // Stream chunks and Tool progress remain available to other trace sinks,
    // while the interactive console tree stays focused on lifecycle boundaries.
    if (
      event.type === "event" &&
      event.name === "acp.session.update" &&
      (event.attributes.sessionUpdate === "agent_message_chunk" ||
        event.attributes.sessionUpdate === "agent_thought_chunk" ||
        event.attributes.sessionUpdate === "tool_call_update")
    ) {
      return
    }

    const depths = runs.get(event.runId) ?? new Map<string, number>()
    runs.set(event.runId, depths)
    const depth = event.parentSpanId === undefined ? 0 : (depths.get(event.parentSpanId) ?? 0) + 1
    depths.set(event.spanId, depth)

    const indent = "  ".repeat(depth)
    const attributes = formatAttributes(event.attributes)
    let line: string

    if (event.type === "span.start") {
      const label = event.name.startsWith(`${event.kind}.`) ? event.name : `${event.kind} ${event.name}`
      line = `${indent}▶ ${label}${attributes}`
    } else if (event.type === "span.end") {
      const marker = event.status === "ok" ? "✓" : "✗"
      const label = event.name.startsWith(`${event.kind}.`) ? event.name : `${event.kind} ${event.name}`
      line = `${indent}${marker} ${label} ${formatDuration(event.durationMs)}${attributes}`
    } else {
      line = `${indent}• ${event.name}${attributes}`
    }

    let result: unknown

    try {
      result = Reflect.apply(write, undefined, [line])
    } finally {
      // Evaluation completion is the last event in one run. Cleanup belongs in
      // finally because a custom writer may throw on the terminal line.
      if (event.type === "span.end" && event.kind === "evaluation") {
        runs.delete(event.runId)
      }
    }

    // Forward the writer result so the event layer can report a rejected
    // Promise without joining observability to workflow completion.
    return result
  }) as TraceSink

  // The event registry captures this policy once when the sink is registered.
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
function formatAttributes(attributes: Readonly<Record<string, AmlTraceAttribute>>): string {
  const entries = Object.entries(attributes)

  if (entries.length === 0) {
    return ""
  }

  return ` ${entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ")}`
}

/**
 * Keeps short spans readable while retaining sub-millisecond timing.
 */
function formatDuration(durationMs: number): string {
  return durationMs < 10 ? `${durationMs.toFixed(1)}ms` : `${Math.round(durationMs)}ms`
}
