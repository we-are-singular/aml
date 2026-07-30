import { randomUUID } from "node:crypto"

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3"
import { WorkspaceConflictError } from "@aml-jsx/sdk"

const LOCK_STALE_MS = 20 * 60 * 1_000
const LOCK_UPDATE_MS = 5 * 60 * 1_000
const MAX_LOCK_BYTES = 4 * 1_024

interface S3WorkspaceLockRequest {
  readonly bucket: string
  readonly client: S3Client
  readonly key: string
  readonly signal: AbortSignal
  readonly workspaceId: string
}

interface S3WorkspaceLockRecord {
  readonly token: string
  readonly updatedAt: number
}

/**
 * Fixed-policy S3 lease held for one Workspace evaluation.
 *
 * A heartbeat keeps a live run younger than the 20-minute stale boundary.
 * There are deliberately no public timing or recovery options.
 */
export class S3WorkspaceLock {
  readonly #bucket: string
  readonly #client: S3Client
  #etag: string
  #failure: Error | undefined
  readonly #key: string
  #refresh: Promise<void> | undefined
  #release: Promise<void> | undefined
  #releasing = false
  #timer: NodeJS.Timeout | undefined
  readonly #token: string
  readonly #workspaceId: string

  private constructor(request: S3WorkspaceLockRequest, token: string, etag: string) {
    this.#bucket = request.bucket
    this.#client = request.client
    this.#etag = etag
    this.#key = request.key
    this.#token = token
    this.#workspaceId = request.workspaceId
    this.#scheduleRefresh()
  }

  /**
   * Creates the lock object or takes over an observed stale owner.
   */
  static async lock(request: S3WorkspaceLockRequest): Promise<S3WorkspaceLock> {
    request.signal.throwIfAborted()
    const token = randomUUID()
    let etag: string

    try {
      // S3's create-if-absent precondition is the acquisition boundary. A
      // failed precondition means another process may still own the Workspace.
      etag = requireEtag(
        await request.client.send(
          new PutObjectCommand({
            Body: lockBody(token),
            Bucket: request.bucket,
            ContentType: "application/json",
            IfNoneMatch: "*",
            Key: request.key,
          }),
          { abortSignal: request.signal }
        )
      )
    } catch (cause) {
      request.signal.throwIfAborted()

      if (!isPreconditionFailure(cause)) {
        throw new Error(`S3 Workspace "${request.workspaceId}" lock acquisition failed`, { cause })
      }

      etag = await replaceStaleLock(request, token)
    }

    return new S3WorkspaceLock(request, token, etag)
  }

  /**
   * Surfaces a heartbeat failure before the lease performs more storage work.
   */
  check(): void {
    if (this.#failure !== undefined) {
      throw this.#failure
    }
  }

  /**
   * Stops heartbeats and removes only the lock still carrying this run's token.
   */
  unlock(): Promise<void> {
    this.#release ??= this.#unlockOnce()
    return this.#release
  }

  async #unlockOnce(): Promise<void> {
    this.#releasing = true

    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }

    // A refresh may already be in flight when release begins. Let it settle
    // before checking ownership and deleting the lock object.
    await this.#refresh
    this.check()

    try {
      const current = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: this.#key,
        })
      )
      const record = parseLock(await readBody(current.Body), this.#workspaceId)

      if (record.token !== this.#token) {
        throw this.#lost()
      }

      // Conditional DELETE is not consistently implemented by S3-compatible
      // services. A current token cannot be replaced before its stale window.
      await this.#client.send(
        new DeleteObjectCommand({
          Bucket: this.#bucket,
          Key: this.#key,
        })
      )
    } catch (cause) {
      if (cause instanceof Error && cause.message === `S3 Workspace "${this.#workspaceId}" lock was lost`) {
        throw cause
      }

      throw this.#lost(cause)
    }
  }

  #scheduleRefresh(): void {
    if (this.#releasing || this.#failure !== undefined) {
      return
    }

    this.#timer = setTimeout(() => {
      this.#refresh = this.#refreshOnce()
    }, LOCK_UPDATE_MS)
    this.#timer.unref()
  }

  async #refreshOnce(): Promise<void> {
    try {
      // IfMatch both refreshes the timestamp and proves that no stale-lock
      // takeover replaced the object since the previous acknowledged write.
      const refreshed = await this.#client.send(
        new PutObjectCommand({
          Body: lockBody(this.#token),
          Bucket: this.#bucket,
          ContentType: "application/json",
          IfMatch: this.#etag,
          Key: this.#key,
        })
      )
      this.#etag = requireEtag(refreshed)
    } catch (cause) {
      this.#failure = this.#lost(cause)
    } finally {
      this.#refresh = undefined
      this.#scheduleRefresh()
    }
  }

  #lost(cause?: unknown): Error {
    return new Error(`S3 Workspace "${this.#workspaceId}" lock was lost`, cause === undefined ? {} : { cause })
  }
}

/**
 * Replaces an expired lock only while its observed ETag remains current.
 */
async function replaceStaleLock(request: S3WorkspaceLockRequest, token: string): Promise<string> {
  let current

  try {
    current = await request.client.send(
      new GetObjectCommand({
        Bucket: request.bucket,
        Key: request.key,
      }),
      { abortSignal: request.signal }
    )
  } catch (cause) {
    request.signal.throwIfAborted()
    throw new Error(`S3 Workspace "${request.workspaceId}" could not inspect its lock`, { cause })
  }

  const etag = requireEtag(current)
  const record = parseLock(await readBody(current.Body), request.workspaceId)

  if (Date.now() - record.updatedAt <= LOCK_STALE_MS) {
    throw new WorkspaceConflictError(request.workspaceId)
  }

  try {
    // Two contenders can observe the same stale record; the ETag lets exactly
    // one of them become the new owner.
    return requireEtag(
      await request.client.send(
        new PutObjectCommand({
          Body: lockBody(token),
          Bucket: request.bucket,
          ContentType: "application/json",
          IfMatch: etag,
          Key: request.key,
        }),
        { abortSignal: request.signal }
      )
    )
  } catch (cause) {
    request.signal.throwIfAborted()

    if (isPreconditionFailure(cause)) {
      throw new WorkspaceConflictError(request.workspaceId)
    }

    throw new Error(`S3 Workspace "${request.workspaceId}" could not replace its stale lock`, { cause })
  }
}

function lockBody(token: string): string {
  return JSON.stringify({
    token,
    updatedAt: Date.now(),
  } satisfies S3WorkspaceLockRecord)
}

function parseLock(value: string, workspaceId: string): S3WorkspaceLockRecord {
  let parsed: unknown

  try {
    parsed = JSON.parse(value)
  } catch (cause) {
    throw new Error(`S3 Workspace "${workspaceId}" lock is not valid JSON`, { cause })
  }

  const token = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "token") : undefined
  const updatedAt = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "updatedAt") : undefined

  if (typeof token !== "string" || token.length === 0 || !Number.isSafeInteger(updatedAt)) {
    throw new Error(`S3 Workspace "${workspaceId}" lock is invalid`)
  }

  return { token, updatedAt: updatedAt as number }
}

/**
 * Reads the small control object without allowing an unbounded response body.
 */
async function readBody(body: unknown): Promise<string> {
  if (body === undefined || body === null || typeof body !== "object" || !(Symbol.asyncIterator in body)) {
    throw new TypeError("S3 Workspace lock did not contain a streaming body")
  }

  const chunks: Buffer[] = []
  let bytes = 0

  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength

    if (bytes > MAX_LOCK_BYTES) {
      throw new RangeError(`S3 Workspace lock exceeded ${MAX_LOCK_BYTES} bytes`)
    }

    chunks.push(Buffer.from(chunk))
  }

  return Buffer.concat(chunks).toString("utf8")
}

function requireEtag(value: { readonly ETag?: string | undefined }): string {
  if (typeof value.ETag !== "string" || value.ETag.length === 0) {
    throw new Error("S3 Workspace lock operation did not return an ETag")
  }

  return value.ETag
}

function isPreconditionFailure(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const status = Reflect.get(Reflect.get(value, "$metadata") ?? {}, "httpStatusCode")
  const name = Reflect.get(value, "name")
  const code = Reflect.get(value, "Code") ?? Reflect.get(value, "code")
  return status === 409 || status === 412 || name === "PreconditionFailed" || code === "PreconditionFailed"
}
