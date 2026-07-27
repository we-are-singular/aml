import {
  Agent,
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

const Repository = createContext<SessionRepository>("SessionRepository")

/**
 * Calls the JavaScript Tool attached by the Context-aware Agent component.
 */
const ExampleProvider = new DeterministicAgentProvider({
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
 * Captures the scoped repository without rendering it into the prompt.
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
    <Agent provider={ExampleProvider}>
      <Tool use={listOrders} />
      Inspect the active session orders.
    </Agent>
  )
}

/**
 * Demonstrates an immutable dependency scope captured by a JavaScript Tool.
 */
export default function ContextExample() {
  return (
    <Repository.Provider value={new SessionRepository()}>
      <OrderAgent />
    </Repository.Provider>
  )
}
