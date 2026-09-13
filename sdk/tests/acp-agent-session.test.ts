import { agent, methods, ndJsonStream, RequestError, type StopReason } from "@agentclientprotocol/sdk"
import { describe, expect, it } from "vitest"

import { openAcpSession, type AcpStructuredOutputController } from "../src/components/agent/acp-agent-session.js"
import { AcpAgentError } from "../src/components/agent/acp-agent-error.js"
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

  it.each(["cancelled", "refusal", "max_tokens", "max_turn_requests"] as const)(
    "does not repair missing output after %s",
    async stopReason => {
      const prompts: string[] = []
      const context = createAgentExecutionContext()
      const session = await openAcpSession({
        cwd: "/workspace",
        observability: agentObservabilityServices(context),
        process: acpProcess(prompt => prompts.push(prompt), [{ text: "Incomplete answer", stopReason }]),
        signal: context.signal,
        structuredOutput: new StructuredOutputFixture(),
      })
      try {
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
        ).rejects.toMatchObject({
          name: "AcpAgentError",
          sessionId: "session-test",
          attempts: [{ text: "Incomplete answer", stopReason }],
        })
        expect(prompts).toHaveLength(1)
      } finally {
        await session.close()
      }
    }
  )

  it.each([false, true])("retains both responses when the repair fails (protocol error: %s)", async protocolError => {
    const context = createAgentExecutionContext()
    const session = await openAcpSession({
      cwd: "/workspace",
      observability: agentObservabilityServices(context),
      process: acpProcess(() => {}, [
        { text: "Completed original work" },
        {
          text: "Repair output",
          ...(protocolError ? { error: RequestError.internalError({ detail: "provider failure" }) } : {}),
        },
      ]),
      signal: context.signal,
      structuredOutput: new StructuredOutputFixture(),
    })
    try {
      const error = await session
        .runTurn(
          {
            index: 0,
            isFinal: true,
            output: { jsonSchema: { type: "string" }, type: "json" },
            prompt: "Return a string.",
          },
          context
        )
        .catch(error => error)
      expect(error).toBeInstanceOf(AcpAgentError)
      expect(error.sessionId).toBe("session-test")
      expect(error.attempts).toEqual([
        { text: "Completed original work", stopReason: "end_turn" },
        { text: "Repair output", ...(protocolError ? {} : { stopReason: "end_turn" }) },
      ])
      expect(Object.isFrozen(error.attempts)).toBe(true)
      expect(Object.isFrozen(error.attempts[0])).toBe(true)
      if (protocolError) expect(error.cause).toMatchObject({ code: -32603, data: { detail: "provider failure" } })
      else expect(error.cause.message).toContain("did not submit")
    } finally {
      await session.close()
    }
  })

  it.each([1, 2])("preserves caller cancellation during prompt %s", async cancelAt => {
    const controller = new AbortController()
    const cancellation = new Error("Caller cancelled the evaluation")
    const prompts: string[] = []
    const context = createAgentExecutionContext({ signal: controller.signal })
    const session = await openAcpSession({
      cwd: "/workspace",
      observability: agentObservabilityServices(context),
      process: acpProcess(prompt => {
        prompts.push(prompt)
        if (prompts.length === cancelAt) controller.abort(cancellation)
      }),
      signal: context.signal,
      structuredOutput: new StructuredOutputFixture(),
    })
    try {
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
      ).rejects.toBe(cancellation)
      expect(prompts).toHaveLength(cancelAt)
    } finally {
      await session.close()
    }
  })

  it("does not issue a repair after a protocol error on the authored prompt", async () => {
    const prompts: string[] = []
    const context = createAgentExecutionContext()
    const session = await openAcpSession({
      cwd: "/workspace",
      observability: agentObservabilityServices(context),
      process: acpProcess(
        prompt => prompts.push(prompt),
        [{ text: "Partial answer", error: RequestError.internalError({ detail: "provider failure" }) }]
      ),
      signal: context.signal,
      structuredOutput: new StructuredOutputFixture(),
    })
    try {
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
      ).rejects.toMatchObject({
        name: "AcpAgentError",
        attempts: [{ text: "Partial answer" }],
        cause: { code: -32603 },
      })
      expect(prompts).toHaveLength(1)
    } finally {
      await session.close()
    }
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

function acpProcess(
  onPrompt: (prompt: string) => void,
  replies: readonly { text?: string; stopReason?: StopReason; error?: RequestError }[] = []
): Readonly<SandboxProcess> {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  let resolveExited: () => void = () => undefined
  const exited = new Promise<void>(resolve => {
    resolveExited = resolve
  })
  let index = 0
  const app = agent({ name: "session-test" })
    .onRequest(methods.agent.initialize, ({ params }) => ({
      protocolVersion: params.protocolVersion,
    }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: "session-test" }))
    .onRequest(methods.agent.session.prompt, async ({ params }) => {
      onPrompt(params.prompt.flatMap(block => (block.type === "text" ? [block.text] : [])).join(""))
      const reply = replies[index++]
      if (reply?.text !== undefined)
        await connection.client.notify(methods.client.session.update, {
          sessionId: "session-test",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply.text } },
        })
      if (reply?.error !== undefined) throw reply.error
      return { stopReason: reply?.stopReason ?? "end_turn" }
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
