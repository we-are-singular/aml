import type Dockerode from "dockerode"

/**
 * Resolves when Dockerode has decoded a complete image-build stream.
 */
export function followDockerBuildProgress(client: Dockerode, stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    // Dockerode 5 exposes BuildKit-aware progress decoding while its current
    // DefinitelyTyped declaration still exposes only the underlying modem.
    const followProgress = (
      client as Dockerode & {
        followProgress(
          input: NodeJS.ReadableStream,
          done: (error: Error | null, output: readonly unknown[]) => void
        ): void
      }
    ).followProgress

    followProgress.call(client, stream, (error, output) => {
      if (error !== null) {
        reject(error)
        return
      }

      // Docker build failures arrive inside an HTTP 200 progress stream. The
      // transport can complete while decoded output carries the Engine error.
      const buildError = findDockerProgressError(output)

      if (buildError !== undefined) {
        reject(new Error(buildError))
        return
      }

      resolve()
    })
  })
}

/**
 * Extracts a structured Engine failure from decoded Docker progress events.
 */
function findDockerProgressError(output: readonly unknown[]): string | undefined {
  for (const value of output) {
    if (typeof value !== "object" || value === null) {
      continue
    }

    const event = value as {
      readonly error?: unknown
      readonly errorDetail?: unknown
    }

    if (typeof event.error === "string" && event.error.length > 0) {
      return event.error
    }

    if (
      typeof event.errorDetail === "object" &&
      event.errorDetail !== null &&
      "message" in event.errorDetail &&
      typeof event.errorDetail.message === "string" &&
      event.errorDetail.message.length > 0
    ) {
      return event.errorDetail.message
    }
  }

  return undefined
}
