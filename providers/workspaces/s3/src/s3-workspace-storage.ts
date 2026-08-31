import { Readable } from "node:stream"

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3"
import {
  workspaceStorageSegment,
  type WorkspaceStorageAcquireRequest,
  type WorkspaceStorageAdapter,
  type WorkspaceStorageBody,
  type WorkspaceStorageEntry,
  type WorkspaceStorageLease,
  type WorkspaceStorageObject,
  type WorkspaceStorageVersion,
  type WorkspaceStorageWriteOptions,
} from "@aml-jsx/sdk"

import { S3WorkspaceLock } from "./s3-workspace-lock.js"
import type { ParsedS3WorkspaceOptions } from "./s3-workspace-options.js"

/** Provider handle identifying the S3 namespace used by one Workspace lease. */
export interface S3WorkspaceStorageHandle {
  /** Bucket containing this logical Workspace's persistence objects. */
  readonly bucket: string

  /** Stable storage-handle discriminant. */
  readonly kind: "s3-workspace"

  /** Configured object-key namespace shared by AML Workspace objects. */
  readonly prefix: string
}

/**
 * Opens one S3 object namespace for WorkspacePersistence.
 *
 * The optional run lock uses one fixed internal heartbeat policy, so storage
 * consumers cannot tune provider-specific timing.
 */
export class S3WorkspaceStorage implements WorkspaceStorageAdapter<S3WorkspaceStorageHandle> {
  #client: S3Client | undefined
  readonly #options: Readonly<ParsedS3WorkspaceOptions>
  readonly name = "s3"

  constructor(options: Readonly<ParsedS3WorkspaceOptions>) {
    this.#options = options
    this.#client = options.client
  }

  async acquire(request: WorkspaceStorageAcquireRequest): Promise<WorkspaceStorageLease<S3WorkspaceStorageHandle>> {
    request.signal.throwIfAborted()
    const client = this.#getClient()
    const objectRoot = `${this.#options.prefix}/${workspaceStorageSegment(request.id)}`
    const lock = request.lock
      ? await S3WorkspaceLock.lock({
          bucket: this.#options.bucket,
          client,
          key: `${objectRoot}/lock.json`,
          signal: request.signal,
          workspaceId: request.id,
        })
      : undefined

    return new S3WorkspaceStorageLease(client, this.#options.bucket, objectRoot, lock, this.#options.prefix, request)
  }

  #getClient(): S3Client {
    this.#client ??= new S3Client({
      region: "us-east-1",
      ...this.#options.config,
    })
    return this.#client
  }
}

/**
 * Maps the five provider-neutral storage operations to S3 commands.
 */
class S3WorkspaceStorageLease implements WorkspaceStorageLease<S3WorkspaceStorageHandle> {
  readonly #bucket: string
  readonly #client: S3Client
  readonly #lock: S3WorkspaceLock | undefined
  readonly #objectRoot: string
  readonly #request: WorkspaceStorageAcquireRequest
  readonly handle: S3WorkspaceStorageHandle

  constructor(
    client: S3Client,
    bucket: string,
    objectRoot: string,
    lock: S3WorkspaceLock | undefined,
    prefix: string,
    request: WorkspaceStorageAcquireRequest
  ) {
    this.#bucket = bucket
    this.#client = client
    this.#lock = lock
    this.#objectRoot = objectRoot
    this.#request = request
    this.handle = Object.freeze({
      bucket,
      kind: "s3-workspace",
      prefix,
    })
  }

  async delete(paths: readonly string[]): Promise<void> {
    this.#lock?.check()

    for (const objectPath of paths) {
      await this.#client.send(
        new DeleteObjectCommand({
          Bucket: this.#bucket,
          Key: this.#key(objectPath),
        }),
        { abortSignal: this.#request.signal }
      )
    }
  }

  async list(prefix: string): Promise<readonly WorkspaceStorageEntry[]> {
    this.#lock?.check()
    const keyPrefix = this.#key(prefix)
    const paths: string[] = []
    let continuationToken: string | undefined

    // S3-compatible stores may paginate even small folder revisions.
    do {
      const listed = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          ContinuationToken: continuationToken,
          Prefix: keyPrefix,
        }),
        { abortSignal: this.#request.signal }
      )

      for (const object of listed.Contents ?? []) {
        if (object.Key !== undefined) {
          paths.push(object.Key.slice(this.#objectRoot.length + 1))
        }
      }

      continuationToken = listed.NextContinuationToken
    } while (continuationToken !== undefined)

    return Object.freeze(paths.sort().map(path => Object.freeze({ path })))
  }

  async read(objectPath: string): Promise<WorkspaceStorageObject | undefined> {
    this.#lock?.check()
    let object: GetObjectCommandOutput

    try {
      object = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: this.#key(objectPath),
        }),
        { abortSignal: this.#request.signal }
      )
    } catch (cause) {
      this.#request.signal.throwIfAborted()

      if (isMissingObject(cause)) {
        return undefined
      }

      throw cause
    }

    return Object.freeze({
      body: requireAsyncBody(object.Body, this.#request.id, objectPath),
      version: Object.freeze({ value: requireEtag(object, this.#request.id, objectPath) }),
    })
  }

  release(): Promise<void> {
    return this.#lock?.unlock() ?? Promise.resolve()
  }

  async write(
    objectPath: string,
    body: WorkspaceStorageBody,
    options: WorkspaceStorageWriteOptions = {}
  ): Promise<WorkspaceStorageVersion> {
    this.#lock?.check()
    const output = await this.#client.send(
      new PutObjectCommand({
        Body: toS3Body(body),
        Bucket: this.#bucket,
        ...(options.condition?.kind === "absent" ? { IfNoneMatch: "*" } : {}),
        ...(options.condition?.kind === "version" ? { IfMatch: options.condition.version.value } : {}),
        ...(options.contentLength === undefined ? {} : { ContentLength: options.contentLength }),
        ...(options.contentType === undefined ? {} : { ContentType: options.contentType }),
        Key: this.#key(objectPath),
      }),
      { abortSignal: this.#request.signal }
    )

    return Object.freeze({ value: requireEtag(output, this.#request.id, objectPath) })
  }

  #key(objectPath: string): string {
    if (
      objectPath.length === 0 ||
      objectPath.startsWith("/") ||
      objectPath.includes("\\") ||
      objectPath.split("/").some(segment => segment === "." || segment === "..")
    ) {
      throw new TypeError(`S3 Workspace storage path "${objectPath}" is invalid`)
    }

    return `${this.#objectRoot}/${objectPath}`
  }
}

function toS3Body(body: WorkspaceStorageBody): string | Uint8Array | Readable {
  return typeof body === "string" || body instanceof Uint8Array ? body : Readable.from(body)
}

function requireAsyncBody(
  body: GetObjectCommandOutput["Body"],
  workspaceId: string,
  objectPath: string
): AsyncIterable<Uint8Array> {
  if (
    body === undefined ||
    typeof body !== "object" ||
    !(Symbol.asyncIterator in body) ||
    typeof body[Symbol.asyncIterator] !== "function"
  ) {
    throw new TypeError(`S3 Workspace "${workspaceId}" object "${objectPath}" did not return a streaming body`)
  }

  return body as AsyncIterable<Uint8Array>
}

function requireEtag(value: { readonly ETag?: string | undefined }, workspaceId: string, objectPath: string): string {
  if (typeof value.ETag !== "string" || value.ETag.length === 0) {
    throw new Error(`S3 Workspace "${workspaceId}" object "${objectPath}" did not return an ETag`)
  }

  return value.ETag
}

function isMissingObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const status = Reflect.get(Reflect.get(value, "$metadata") ?? {}, "httpStatusCode")
  const name = Reflect.get(value, "name")
  const code = Reflect.get(value, "Code") ?? Reflect.get(value, "code")
  return status === 404 || name === "NoSuchKey" || code === "NoSuchKey" || code === "NotFound"
}
