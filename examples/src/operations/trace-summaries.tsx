import { AsyncLocalStorage } from "node:async_hooks"

import { AmlRuntime, createTraceSummaryCollector, withTraceSpan } from "@aml-jsx/sdk"

const requestContext = new AsyncLocalStorage<string>()
const runIdsByRequest = new Map<string, string>()
const summaries = createTraceSummaryCollector()
const runtime = new AmlRuntime({
  onTraceError(error, event) {
    console.error("AML trace sink failed", { error, sequence: event.sequence })
  },
  trace: summaries.trace,
})

runtime.on("start", event => {
  const requestId = requestContext.getStore()
  if (requestId !== undefined) runIdsByRequest.set(requestId, event.runId)
})

async function ReviewPhase({ candidates }: { readonly candidates: number }) {
  return await withTraceSpan("review.validate", async () => `validated ${candidates}`)
}

/**
 * Correlates overlapping application requests without relying on a latest run.
 */
async function evaluateRequest(requestId: string, candidates: number) {
  try {
    const value = await requestContext.run(
      requestId,
      async () => await runtime.evaluate(<ReviewPhase candidates={candidates} />)
    )
    const runId = runIdsByRequest.get(requestId)

    if (runId === undefined) throw new Error(`AML run identity was not captured for request ${requestId}`)
    const summary = summaries.forRun(runId)
    if (summary === undefined) throw new Error(`AML summary was not completed for run ${runId}`)

    return { summary, value }
  } finally {
    const runId = runIdsByRequest.get(requestId)
    if (runId !== undefined) summaries.deleteRun(runId)
    runIdsByRequest.delete(requestId)
  }
}

const [first, second] = await Promise.all([evaluateRequest("request-1", 3), evaluateRequest("request-2", 7)])

// providerUsage is [] when the active provider reports no usage. ACP usage is
// retained as provider-reported JSON; AML does not reinterpret turns as calls,
// invent token fields, calculate costs, or infer cache behavior.
console.log(JSON.stringify([first, second], null, 2))
