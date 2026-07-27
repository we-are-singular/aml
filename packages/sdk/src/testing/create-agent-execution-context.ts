import type { AgentExecutionContext } from "../components/agent/agent-execution-context.js"
import type { AmlEventSubscriber } from "../core/aml-event-subscriber.js"

const NOOP_EVENTS: AmlEventSubscriber = Object.freeze({
  on: () => () => undefined,
  once: () => () => undefined,
})

/**
 * Creates the provider context shared by conformance and adapter tests.
 *
 * Narrow overrides keep provider-specific clients local while one SDK fixture
 * absorbs additions to the portable Agent execution contract.
 */
export function createAgentExecutionContext(
  overrides: Partial<AgentExecutionContext> = {},
): Readonly<AgentExecutionContext> {
  const trace = overrides.trace ?? {
    runId: "agent-test",
    spanId: "agent-test",
  }

  return Object.freeze({
    events: overrides.events ?? NOOP_EVENTS,
    ...(overrides.sandbox === undefined
      ? {}
      : { sandbox: overrides.sandbox }),
    signal:
      overrides.signal ?? new AbortController().signal,
    trace: Object.freeze({
      ...(trace.parentSpanId === undefined
        ? {}
        : { parentSpanId: trace.parentSpanId }),
      runId: trace.runId,
      spanId: trace.spanId,
    }),
  })
}
