import {
  Agent,
  AmlRuntime,
  createContext,
  defineTool,
  Tool,
  useContext,
} from "@aml/sdk"
import { DeterministicAgentProvider } from "@aml/sdk/testing"
import { z } from "zod"

class SessionRepository {
  /**
   * Represents session-owned application I/O that must not become prompt text.
   */
  async listOrders(): Promise<readonly string[]> {
    return ["order-17", "order-29"]
  }
}

const Repository = createContext<SessionRepository>(
  "SessionRepository",
)

const provider = new DeterministicAgentProvider({
  /**
   * Emulates a model calling the exact JavaScript Tool granted by the Agent.
   */
  async respond(request, context) {
    const tool = request.tools.find(
      (candidate) => candidate.name === "list_session_orders",
    )

    if (tool?.kind !== "javascript") {
      throw new Error("Session Tool was not granted")
    }

    const orders = await tool.execute(
      {},
      Object.freeze({
        signal: context.signal,
        trace: context.trace,
      }),
    )

    return { text: `orders:${JSON.stringify(orders)}` }
  },
})

/**
 * Captures a scoped repository in a Tool closure without rendering it.
 */
function OrderAgent() {
  const repository = useContext(Repository)
  const listOrders = defineTool({
    description: "List orders for the active application session.",
    execute: async () => await repository.listOrders(),
    input: z.object({}),
    name: "list_session_orders",
  })

  return (
    <Agent>
      <Tool use={listOrders} />
      Inspect the active session orders.
    </Agent>
  )
}

const output = await new AmlRuntime({
  agentProvider: provider,
}).evaluate(
  <Repository.Provider value={new SessionRepository()}>
    <OrderAgent />
  </Repository.Provider>,
)

if (output !== 'orders:["order-17","order-29"]') {
  throw new Error(`Unexpected Context output: ${output}`)
}

if (
  provider.calls[0]?.request.prompt !==
  "Inspect the active session orders."
) {
  throw new Error("Context dependency leaked into Agent prompt text")
}

console.log(output)
