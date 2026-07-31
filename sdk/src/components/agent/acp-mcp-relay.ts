import { randomUUID } from "node:crypto"
import path from "node:path"

import type { AcpMcpBridgeConnection } from "./acp-mcp-bridge.js"
import type { SandboxProcess, SandboxRuntime } from "../sandbox/sandbox-runtime.js"
import relayProgram from "./acp-mcp-relay-program.cjs?raw"
import { materializeSandboxFiles } from "./sandbox-file-materializer.js"

const MAX_RELAY_LINE_BYTES = 8 * 1024 * 1024

/**
 * Host side of an invocation-owned HTTP relay running inside a Sandbox.
 */
export class AcpMcpRelay {
  readonly #bridge: Readonly<AcpMcpBridgeConnection>
  readonly #directory: string
  readonly #process: Readonly<SandboxProcess>
  readonly #pump: Promise<void>
  readonly #requests = new AbortController()
  readonly #runtime: Readonly<SandboxRuntime>
  readonly #stderr: Promise<string>
  #closePromise: Promise<void> | undefined
  #writeBarrier = Promise.resolve()

  private constructor(
    bridge: Readonly<AcpMcpBridgeConnection>,
    directory: string,
    process: Readonly<SandboxProcess>,
    pump: Promise<void>,
    runtime: Readonly<SandboxRuntime>,
    stderr: Promise<string>
  ) {
    this.#bridge = bridge
    this.#directory = directory
    this.#process = process
    this.#pump = pump
    this.#runtime = runtime
    this.#stderr = stderr
  }

  /**
   * Starts the dependency-free loopback relay through the Sandbox process port.
   */
  static async start(
    runtime: Readonly<SandboxRuntime>,
    cwd: string,
    bridge: Readonly<AcpMcpBridgeConnection>,
    signal: AbortSignal
  ): Promise<{ readonly connection: Readonly<AcpMcpBridgeConnection>; readonly relay: AcpMcpRelay }> {
    const directory = `/tmp/aml-mcp-relay-${randomUUID()}`
    const program = path.posix.join(directory, "relay.cjs")
    await materializeSandboxFiles(runtime, directory, [{ content: relayProgram, path: "relay.cjs" }], signal)

    let process: Readonly<SandboxProcess>
    try {
      process = await runtime.spawn("node", [program], { cwd, signal })
    } catch (error) {
      await removeRelayDirectory(runtime, directory).catch(() => undefined)
      throw error
    }
    const reader = process.stdout.getReader()
    const stderr = drainRelayStderr(process.stderr)
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      const ready = await readRelayLine(
        reader,
        decoder,
        () => buffer,
        value => (buffer = value)
      )

      if (
        typeof ready !== "object" ||
        ready === null ||
        Reflect.get(ready, "kind") !== "ready" ||
        !Number.isSafeInteger(Reflect.get(ready, "port"))
      ) {
        throw new Error("Sandbox MCP relay emitted an invalid readiness message")
      }

      const port = Reflect.get(ready, "port") as number
      const relayReference: { value?: AcpMcpRelay } = {}
      const pump = pumpRelay(reader, decoder, buffer, async message => {
        const relay = relayReference.value
        if (relay === undefined) throw new Error("Sandbox MCP relay forwarded before initialization")
        await relay.#forward(message)
      })
      const relay = new AcpMcpRelay(bridge, directory, process, pump, runtime, stderr)
      relayReference.value = relay

      return {
        connection: Object.freeze({
          headers: bridge.headers,
          name: bridge.name,
          url: `http://127.0.0.1:${port}/mcp`,
        }),
        relay,
      }
    } catch (error) {
      reader.releaseLock()
      await process.kill().catch(() => undefined)
      const errorText = await stderr.catch(() => "")
      await removeRelayDirectory(runtime, directory).catch(() => undefined)
      throw errorText.trim().length === 0
        ? error
        : new Error(`Sandbox MCP relay failed: ${errorText.trim()}`, { cause: error })
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close()
    return this.#closePromise
  }

  async #close(): Promise<void> {
    const errors: unknown[] = []
    this.#requests.abort(new Error("Sandbox MCP relay closed"))

    try {
      await this.#process.kill()
      await Promise.all([this.#pump, this.#stderr])
    } catch (error) {
      errors.push(error)
    }

    try {
      await removeRelayDirectory(this.#runtime, this.#directory)
    } catch (error) {
      errors.push(error)
    }

    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "Sandbox MCP relay cleanup failed")
  }

  async #forward(value: unknown): Promise<void> {
    if (typeof value !== "object" || value === null || Reflect.get(value, "kind") !== "request") {
      throw new Error("Sandbox MCP relay emitted an invalid request")
    }

    const id = Reflect.get(value, "id")
    const method = Reflect.get(value, "method")
    const requestPath = Reflect.get(value, "path")
    const headers = Reflect.get(value, "headers")
    const body = Reflect.get(value, "body")

    if (
      !Number.isSafeInteger(id) ||
      typeof method !== "string" ||
      typeof requestPath !== "string" ||
      typeof headers !== "object" ||
      headers === null ||
      typeof body !== "string"
    ) {
      throw new Error("Sandbox MCP relay request has invalid fields")
    }

    let responseStarted = false

    try {
      const response = await fetch(new URL(requestPath, this.#bridge.url), {
        ...(method === "GET" || method === "HEAD" ? {} : { body }),
        headers: requestHeaders(headers as Record<string, string>),
        method,
        signal:
          method === "GET"
            ? this.#requests.signal
            : AbortSignal.any([this.#requests.signal, AbortSignal.timeout(120_000)]),
      })
      // MCP POST responses are finite. Keep them atomic across providers whose
      // remote stdin API transports complete strings rather than raw sockets.
      if (method !== "GET") {
        await this.#write({
          body: Buffer.from(await response.arrayBuffer()).toString("base64"),
          headers: responseHeaders(response.headers),
          id,
          kind: "response",
          status: response.status,
        })
        return
      }

      await this.#write({
        headers: responseHeaders(response.headers),
        id,
        kind: "response-start",
        status: response.status,
      })
      responseStarted = true

      if (response.body !== null) {
        for await (const chunk of response.body) {
          await this.#write({
            body: Buffer.from(chunk).toString("base64"),
            id,
            kind: "response-chunk",
          })
        }
      }

      await this.#write({ id, kind: "response-end" })
    } catch (error) {
      const message = error instanceof Error ? error.message : "MCP relay request failed"

      if (!responseStarted) {
        await this.#write({
          body: Buffer.from(message).toString("base64"),
          headers: {},
          id,
          kind: "response",
          status: 502,
        })
      } else {
        // Once an SSE response has started, an upstream disconnect is an EOF
        // to the guest client. Destroying its socket leaves some MCP clients
        // waiting on a stream error after their request already completed.
        await this.#write({ id, kind: "response-end" })
      }
    }
  }

  async #write(value: unknown): Promise<void> {
    const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`)
    const write = this.#writeBarrier.then(async () => await this.#process.write(bytes))
    this.#writeBarrier = write.catch(() => undefined)
    await write
  }
}

async function drainRelayStderr(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let tail = ""

  for await (const chunk of stream) {
    tail = `${tail}${decoder.decode(chunk, { stream: true })}`.slice(-16_384)
  }

  return `${tail}${decoder.decode()}`.slice(-16_384)
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

/** Removes connection-specific metadata before crossing the process relay. */
function requestHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())))
}

/** Lets the guest HTTP server select framing for streamed host responses. */
function responseHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers].filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())))
}

async function removeRelayDirectory(runtime: Readonly<SandboxRuntime>, directory: string): Promise<void> {
  const result = await runtime.exec("rm", ["-rf", "--", directory])
  if (result.exitCode !== 0) {
    throw new Error(`Sandbox MCP relay cleanup failed: ${result.stderr.trim()}`)
  }
}

async function readRelayLine(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  getBuffer: () => string,
  setBuffer: (value: string) => void
): Promise<unknown> {
  let buffer = getBuffer()

  while (true) {
    const newline = buffer.indexOf("\n")
    if (newline >= 0) {
      const line = buffer.slice(0, newline)
      setBuffer(buffer.slice(newline + 1))
      return JSON.parse(line)
    }

    const chunk = await reader.read()
    if (chunk.done) {
      throw new Error("Sandbox MCP relay exited before readiness")
    }

    buffer += decoder.decode(chunk.value, { stream: true })
    if (Buffer.byteLength(buffer) > MAX_RELAY_LINE_BYTES) {
      throw new Error("Sandbox MCP relay readiness exceeded its output limit")
    }
  }
}

async function pumpRelay(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  initialBuffer: string,
  onMessage: (value: unknown) => Promise<void>
): Promise<void> {
  let buffer = initialBuffer
  const pending = new Set<Promise<void>>()

  try {
    while (true) {
      let newline = buffer.indexOf("\n")

      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)

        if (line.length > 0) {
          const operation = onMessage(JSON.parse(line)).finally(() => pending.delete(operation))
          pending.add(operation)
        }

        newline = buffer.indexOf("\n")
      }

      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })

      if (Buffer.byteLength(buffer) > MAX_RELAY_LINE_BYTES) {
        throw new Error("Sandbox MCP relay message exceeded its output limit")
      }
    }

    buffer += decoder.decode()
    if (buffer.trim().length > 0) {
      const operation = onMessage(JSON.parse(buffer))
      pending.add(operation)
    }
    await Promise.all(pending)
  } finally {
    reader.releaseLock()
  }
}
