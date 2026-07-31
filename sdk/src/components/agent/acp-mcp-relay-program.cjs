const http = require("node:http")
const readline = require("node:readline")

const MAX_BODY_BYTES = 4 * 1024 * 1024
const pending = new Map()
let nextId = 1

// This server is intentionally transport-only. The authenticated MCP server,
// JavaScript Tool execution, and structured-output state stay in the AML host.
const server = http.createServer((request, response) => {
  const chunks = []
  let bytes = 0
  request.on("data", chunk => {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) {
      response.writeHead(413).end()
      request.destroy()
      return
    }
    chunks.push(chunk)
  })
  request.on("end", () => {
    if (response.writableEnded) return

    const id = nextId++
    pending.set(id, response)
    process.stdout.write(
      `${JSON.stringify({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: request.headers,
        id,
        kind: "request",
        method: request.method,
        path: request.url,
      })}\n`
    )
  })
})

readline.createInterface({ input: process.stdin }).on("line", line => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  const response = pending.get(message.id)
  if (!response) return

  if (message.kind === "response") {
    pending.delete(message.id)
    response.writeHead(message.status, message.headers).end(Buffer.from(message.body, "base64"))
    return
  }

  if (message.kind === "response-start") {
    response.writeHead(message.status, message.headers)
    return
  }

  if (message.kind === "response-chunk") {
    response.write(Buffer.from(message.body, "base64"))
    return
  }

  if (message.kind === "response-end") {
    pending.delete(message.id)
    response.end()
    return
  }
})

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ kind: "ready", port: server.address().port })}\n`)
})
