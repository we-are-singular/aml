import process from "node:process"

import { Agent, AmlRuntime, createConsoleTracer, defineTool, FollowUp, opencodeAgent, Tool } from "@aml-jsx/sdk"
import { z } from "zod"

const INCIDENT_PACKET = Object.freeze({
  deploy: "2026-08-12T09:42:00Z",
  observation: "Checkout latency rose from 180ms to 2.4s after the deploy.",
  rollback: "Not started",
  traces: ["database span: 71ms", "payment-provider span: 2.1s", "cache span: 4ms"],
})

const ReadIncidentPacket = defineTool({
  description: "Read the complete, application-owned incident packet",
  input: z.object({}),
  name: "read_incident_packet",
  async execute() {
    return INCIDENT_PACKET
  },
})

const provider = opencodeAgent({
  model: process.env.AML_OPENCODE_MODEL ?? "opencode-go/deepseek-v4-flash",
})

/**
 * Keeps the Agent, its capability, and its ordered turns readable as one AML tree.
 */
function IncidentReview() {
  return (
    <Agent
      provider={provider}
      system="You are an incident analyst. Separate direct evidence, inference, and missing information."
    >
      <Tool use={ReadIncidentPacket} />
      Call read_incident_packet. Form a preliminary incident hypothesis using only the returned evidence.
      <FollowUp>
        Audit the preliminary hypothesis. Identify the strongest alternative explanation and the next observation that
        would distinguish between them.
      </FollowUp>
      <FollowUp>
        Produce the final five-line incident update. Label facts, inference, uncertainty, next check, and rollback
        status.
      </FollowUp>
    </Agent>
  )
}

const runtime = new AmlRuntime({
  maxAgentCalls: 1,
  maxTurnsPerAgent: 3,
  trace: createConsoleTracer({
    // Diagnostic-only: unchanged ACP updates can contain messages, thoughts,
    // Tool input/output, plans, repository context, and errors.
    captureContent: true,
    write: line => process.stderr.write(`${line}\n`),
  }),
})

process.stdout.write(`${await runtime.evaluate(<IncidentReview />)}\n`)
