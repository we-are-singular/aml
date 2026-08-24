import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk"
import { describe, expect, it } from "vitest"

import { openAcpSession, type AcpStructuredOutputController } from "../src/components/agent/acp-agent-session.js"
import { agentObservabilityServices } from "../src/components/agent/agent-observability-services.js"
import type { SandboxProcess } from "../src/components/sandbox/sandbox-runtime.js"
import { createAgentExecutionContext } from "../src/testing/create-agent-execution-context.js"

describe("openAcpSession() structured output", () => {
  it("repairs missing output only after the final authored FollowUp", async () => {
    const prompts: string[] = []
    const output = new StructuredOutputFixture()
    const process = acpProcess(prompt => {
      prompts.push(prompt)
      if (prompts.length === 3) output.accept({ proof: "accepted" })
    })
    const context = createAgentExecutionContext()
    const session = await openAcpSession({
      cwd: "/workspace",
      observability: agentObservabilityServices(context),
      process,
      signal: context.signal,
      structuredOutput: output,
      structuredOutputInstruction: 'Call the provider Tool "qualified_submit" with result.',
    })

    await expect(
      session.runTurn(
        {
          index: 0,
          isFinal: false,
          prompt: "Inspect the repository.",
        },
        context
      )
    ).resolves.toEqual({ text: "" })

    await expect(
      session.runTurn(
        {
          index: 1,
          isFinal: true,
          output: {
            jsonSchema: {
              additionalProperties: false,
              properties: { proof: { type: "string" } },
              required: ["proof"],
              type: "object",
            },
            type: "json",
          },
          prompt: "Submit the final finding.",
        },
        context
      )
    ).resolves.toEqual({ structured: { proof: "accepted" }, text: "" })

    expect(prompts).toHaveLength(3)
    expect(prompts[0]).toBe("Inspect the repository.")
    expect(prompts[1]).toBe('Submit the final finding.\n\nCall the provider Tool "qualified_submit" with result.')
    expect(prompts[2]).toContain("The previous turn ended without submitting a valid structured result.")
    expect(prompts[2]).toContain('Call the provider Tool "qualified_submit" with result.')
    expect(prompts[2]).toContain('"required": [\n    "proof"\n  ]')
    expect(prompts[2]).toContain("Call the structured-result Tool now.")

    await session.close()
  })

  it("stops after one repair turn when the Agent still omits structured output", async () => {
    const prompts: string[] = []
    const output = new StructuredOutputFixture()
    const process = acpProcess(prompt => prompts.push(prompt))
    const context = createAgentExecutionContext()
    const session = await openAcpSession({
      cwd: "/workspace",
      observability: agentObservabilityServices(context),
      process,
      signal: context.signal,
      structuredOutput: output,
    })

    await expect(
      session.runTurn(
        {
          index: 0,
          isFinal: true,
          output: { jsonSchema: { type: "string" }, type: "json" },
          prompt: "Return a string.",
        },
        context
      )
    ).rejects.toThrow("ACP Agent did not submit a valid structured result")
    expect(prompts).toHaveLength(2)

    await session.close()
  })
})

class StructuredOutputFixture implements AcpStructuredOutputController {
  readonly instruction = "Call aml_submit_result."
  #accepted = false
  #value: unknown

  accept(value: unknown): void {
    this.#accepted = true
    this.#value = value
  }

  beginStructuredTurn(): void {}

  hasStructuredResult(): boolean {
    return this.#accepted
  }

  structuredResult(): unknown {
    if (!this.#accepted) throw new Error("ACP Agent did not submit a valid structured result")
    return this.#value
  }
}

function acpProcess(onPrompt: (prompt: string) => void): Readonly<SandboxProcess> {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  let resolveExited: () => void = () => undefined
  const exited = new Promise<void>(resolve => {
    resolveExited = resolve
  })
  const app = agent({ name: "session-test" })
    .onRequest(methods.agent.initialize, ({ params }) => ({
      protocolVersion: params.protocolVersion,
    }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: "session-test" }))
    .onRequest(methods.agent.session.prompt, ({ params }) => {
      onPrompt(params.prompt.flatMap(block => (block.type === "text" ? [block.text] : [])).join(""))
      return { stopReason: "end_turn" }
    })
  const connection = app.connect(ndJsonStream(agentToClient.writable, clientToAgent.readable))

  return Object.freeze({
    id: "session-test",
    async kill() {
      connection.close()
      resolveExited()
    },
    stdin: clientToAgent.writable,
    stderr: emptyStream(),
    stdout: agentToClient.readable,
    async wait() {
      await exited
      return { exitCode: 0 }
    },
  })
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: controller => controller.close() })
}
