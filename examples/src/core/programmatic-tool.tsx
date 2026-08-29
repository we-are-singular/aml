import { defineTool } from "@aml-jsx/sdk"
import { z } from "zod"

const loadOrder = defineTool({
  description: "Load one order for application workflow code.",
  execute: async ({ id }) => ({ id, status: "paid" as const }),
  input: z.object({ id: z.string() }),
  name: "load_order",
  output: z.object({ id: z.string(), status: z.literal("paid") }),
})

async function Workflow() {
  const order = await loadOrder({ id: "order-17" })

  return `order:${order.id}:${order.status}`
}

/**
 * Calls a validated Tool as application work without granting it to a model.
 */
export default function ProgrammaticToolExample() {
  return <Workflow />
}
