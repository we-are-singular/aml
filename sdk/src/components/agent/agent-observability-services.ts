import type { EvaluationContext } from "../../core/evaluation-context.js"
import type { AmlTraceIdentity } from "../../core/trace-identity.js"
import type { TraceSpan } from "../../observability/trace-dispatcher.js"
import type { AmlTraceAttribute, AmlTraceEventName } from "../../observability/trace-event.js"
import type { AgentExecutionContext } from "./agent-execution-context.js"

// CLI workflows can load a second physical SDK copy from the authored module.
// Symbol.for gives both copies one registry without exposing these controls on
// the public AgentExecutionContext passed to third-party providers.
const AML_AGENT_OBSERVABILITY_SERVICES = Symbol.for("@aml-jsx/sdk/agent-observability-services")

type TraceAttributes = Readonly<Record<string, AmlTraceAttribute>>

interface AmlAgentObservabilityGlobal {
  /** Invocation services keyed weakly by the context shared across SDK copies. */
  [AML_AGENT_OBSERVABILITY_SERVICES]?: WeakMap<object, AgentObservabilityServices>
}

/**
 * Runtime-owned trace controls used by AML's built-in Agent lifecycle.
 *
 * Providers receive only an opaque execution context. Keeping publication in
 * this private service prevents arbitrary provider objects from bypassing the
 * runtime's ordering, redaction, and listener-failure boundaries.
 */
export interface AgentObservabilityServices {
  /** Adds metadata discovered inside a span before its owner closes it. */
  addSpanEndAttributes(trace: AmlTraceIdentity, attributes: TraceAttributes): void

  /** Creates a child identity whose events belong to the supplied parent. */
  createTrace(parentSpanId: string): AmlTraceIdentity

  /** Returns the session, turn, or cleanup identity active at this instant. */
  currentTrace(): AmlTraceIdentity

  /** Completes a span; an absent token means tracing was not attached. */
  endSpan(span: TraceSpan | undefined, status: "error" | "ok"): void

  /** Publishes an ordered point event through the runtime trace boundary. */
  event(
    trace: AmlTraceIdentity,
    name: AmlTraceEventName,
    attributes?: TraceAttributes,
    sensitiveAttributes?: TraceAttributes
  ): void

  /** Completes a span with error metadata without coercing the thrown value. */
  failSpan(span: TraceSpan | undefined, error: unknown): void

  /** Serializes content only when the active trace sink opted into capture. */
  sensitiveAttribute(name: string, value: unknown): TraceAttributes

  /** Selects the identity used by asynchronous ACP and process callbacks. */
  setCurrentTrace(trace: AmlTraceIdentity): void

  /** Starts an Agent lifecycle span, or returns no token for the null service. */
  startSpan(
    trace: AmlTraceIdentity,
    name: string,
    attributes?: TraceAttributes,
    sensitiveAttributes?: TraceAttributes
  ): TraceSpan | undefined
}

/** Attaches one invocation's trace controls without widening the provider API. */
export function attachAgentObservabilityServices(context: AgentExecutionContext, evaluation: EvaluationContext): void {
  // ACP discovers stop metadata inside runTurn(), while the generic session
  // executor owns the turn span. Hold those attributes until that owner closes it.
  const endAttributes = new Map<string, TraceAttributes>()

  // One Agent session executes authored turns serially. This cursor lets
  // asynchronous ACP updates attach to the session or currently active turn.
  let currentTrace = context.trace

  observabilityRegistry().set(context, {
    addSpanEndAttributes(trace, attributes) {
      endAttributes.set(trace.spanId, Object.freeze({ ...(endAttributes.get(trace.spanId) ?? {}), ...attributes }))
    },
    createTrace: parentSpanId => evaluation.createObservationTrace(parentSpanId),
    currentTrace: () => currentTrace,
    endSpan(span, status) {
      if (span === undefined) return

      evaluation.endTraceSpan(span, status, endAttributes.get(span.identity.spanId) ?? {})
      endAttributes.delete(span.identity.spanId)
    },
    event: (trace, name, attributes = {}, sensitiveAttributes = {}) =>
      evaluation.traceEvent(trace, name, attributes, sensitiveAttributes),
    failSpan(span, error) {
      if (span === undefined) return

      endAttributes.delete(span.identity.spanId)
      evaluation.failTraceSpan(span, error)
    },
    sensitiveAttribute(name, value) {
      if (!evaluation.capturesTraceContent) return {}

      try {
        return { [name]: JSON.stringify(value) ?? String(value) }
      } catch {
        return { [name]: "[unserializable]" }
      }
    },
    setCurrentTrace(trace) {
      currentTrace = trace
    },
    startSpan: (trace, name, attributes = {}, sensitiveAttributes = {}) =>
      evaluation.startTraceSpan(trace, "agent", name, attributes, sensitiveAttributes),
  })
}

/** Returns the runtime trace controls or a context-local null implementation. */
export function agentObservabilityServices(context: AgentExecutionContext): AgentObservabilityServices {
  const registry = observabilityRegistry()
  const existing = registry.get(context)
  if (existing !== undefined) return existing

  const noop = new NoopAgentObservabilityServices(context.trace)
  registry.set(context, noop)
  return noop
}

/** Keeps Agent lifecycle code total when no runtime trace dispatcher is attached. */
class NoopAgentObservabilityServices implements AgentObservabilityServices {
  #trace: AmlTraceIdentity

  constructor(trace: AmlTraceIdentity) {
    this.#trace = trace
  }

  // Publication methods intentionally do nothing. Keeping the complete
  // interface lets lifecycle code execute without observability branches.
  addSpanEndAttributes(_trace: AmlTraceIdentity, _attributes: TraceAttributes): void {}

  createTrace(_parentSpanId: string): AmlTraceIdentity {
    // The original identity is sufficient because no events will be emitted.
    return this.#trace
  }

  currentTrace(): AmlTraceIdentity {
    return this.#trace
  }

  endSpan(_span: TraceSpan | undefined, _status: "error" | "ok"): void {}

  event(
    _trace: AmlTraceIdentity,
    _name: AmlTraceEventName,
    _attributes?: TraceAttributes,
    _sensitiveAttributes?: TraceAttributes
  ): void {}

  failSpan(_span: TraceSpan | undefined, _error: unknown): void {}

  sensitiveAttribute(_name: string, _value: unknown): TraceAttributes {
    // Never serialize sensitive values when no trace sink requested content.
    return {}
  }

  setCurrentTrace(trace: AmlTraceIdentity): void {
    // Preserve lifecycle cursor semantics for callers that later attach work.
    this.#trace = trace
  }

  startSpan(
    _trace: AmlTraceIdentity,
    _name: string,
    _attributes?: TraceAttributes,
    _sensitiveAttributes?: TraceAttributes
  ): undefined {
    // Terminal methods accept this absent token and no-op in the same service.
    return undefined
  }
}

function observabilityRegistry(): WeakMap<object, AgentObservabilityServices> {
  const amlGlobal = globalThis as typeof globalThis & AmlAgentObservabilityGlobal
  const existing = amlGlobal[AML_AGENT_OBSERVABILITY_SERVICES]

  if (existing !== undefined) {
    if (!(existing instanceof WeakMap)) {
      throw new TypeError("AML Agent observability services registry has an invalid global value")
    }

    return existing
  }

  // CLI-loaded workflows can contain multiple physical SDK copies. Symbol.for
  // keeps the registry shared within the realm, while WeakMap retains nothing
  // after the invocation context becomes unreachable.
  const created = new WeakMap<object, AgentObservabilityServices>()

  Object.defineProperty(amlGlobal, AML_AGENT_OBSERVABILITY_SERVICES, {
    configurable: false,
    enumerable: false,
    value: created,
    writable: false,
  })

  return created
}
