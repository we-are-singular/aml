import { Readable, Writable } from "node:stream"
import { finished } from "node:stream/promises"

import type Dockerode from "dockerode"

/**
 * Collects Docker's multiplexed stdout and stderr with a shared memory cap.
 *
 * Dockerode owns raw-stream framing. AML only bounds and decodes the two
 * resulting byte streams so provider commands cannot grow memory indefinitely.
 */
export async function captureDockerCommandOutput(
  client: Dockerode,
  value: NodeJS.ReadableStream,
  maxOutputBytes: number,
): Promise<Readonly<{ stderr: string; stdout: string }>> {
  const stream = value as Readable
  let capturedBytes = 0
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  const createSink = (chunks: Buffer[]) =>
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        capturedBytes += chunk.byteLength

        if (capturedBytes > maxOutputBytes) {
          callback(
            new RangeError(
              `Docker Sandbox command output exceeded ${maxOutputBytes} bytes`,
            ),
          )
          return
        }

        chunks.push(Buffer.from(chunk))
        callback()
      },
    })
  const stdout = createSink(stdoutChunks)
  const stderr = createSink(stderrChunks)

  // Sink failures must stop the source stream; otherwise demultiplexing can
  // continue after the caller has already rejected the bounded operation.
  stdout.once("error", (error) => stream.destroy(error))
  stderr.once("error", (error) => stream.destroy(error))
  stream.once("end", () => {
    stdout.end()
    stderr.end()
  })
  stream.once("error", (error) => {
    stdout.destroy(error)
    stderr.destroy(error)
  })
  client.modem.demuxStream(stream, stdout, stderr)

  await Promise.all([
    finished(stream),
    finished(stdout),
    finished(stderr),
  ])

  return Object.freeze({
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
  })
}
