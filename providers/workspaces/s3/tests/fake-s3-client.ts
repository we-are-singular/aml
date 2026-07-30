import { Readable } from "node:stream"

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3"

interface StoredObject {
  readonly body: Buffer
  readonly etag: string
}

/**
 * Minimal conditional-object store used to exercise the provider protocol.
 */
export class FakeS3Store {
  readonly #objects = new Map<string, StoredObject>()
  #version = 0

  readonly client = {
    send: async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        return await this.#put(command)
      }

      if (command instanceof GetObjectCommand) {
        return this.#get(command)
      }

      if (command instanceof DeleteObjectCommand) {
        return this.#delete(command)
      }

      if (command instanceof ListObjectsV2Command) {
        return this.#list(command)
      }

      throw new TypeError(`Unsupported fake S3 command: ${command?.constructor.name}`)
    },
  } as unknown as S3Client

  keys(): readonly string[] {
    return [...this.#objects.keys()].sort()
  }

  text(key: string): string | undefined {
    const object = this.#objects.get(key)
    return object === undefined ? undefined : object.body.toString("utf8")
  }

  async put(key: string, body: string | Buffer): Promise<void> {
    this.#objects.set(key, {
      body: Buffer.from(body),
      etag: this.#nextEtag(),
    })
  }

  async #put(command: PutObjectCommand): Promise<{ ETag: string }> {
    const input = command.input
    const key = requireKey(input.Key)
    const current = this.#objects.get(key)

    if (input.IfNoneMatch === "*" && current !== undefined) {
      throw preconditionFailure()
    }

    if (input.IfMatch !== undefined && current?.etag !== input.IfMatch) {
      throw preconditionFailure()
    }

    const object = {
      body: await collectBody(input.Body),
      etag: this.#nextEtag(),
    }
    this.#objects.set(key, object)
    return { ETag: object.etag }
  }

  #get(command: GetObjectCommand): { Body: Readable; ETag: string } {
    const key = requireKey(command.input.Key)
    const object = this.#objects.get(key)

    if (object === undefined) {
      throw missingObject()
    }

    return {
      Body: Readable.from([object.body]),
      ETag: object.etag,
    }
  }

  #delete(command: DeleteObjectCommand): Record<string, never> {
    const key = requireKey(command.input.Key)
    const current = this.#objects.get(key)

    if (command.input.IfMatch !== undefined && current?.etag !== command.input.IfMatch) {
      throw preconditionFailure()
    }

    this.#objects.delete(key)
    return {}
  }

  #list(command: ListObjectsV2Command): { Contents: { Key: string }[]; IsTruncated: false } {
    const prefix = command.input.Prefix ?? ""

    return {
      Contents: this.keys()
        .filter(key => key.startsWith(prefix))
        .map(Key => ({ Key })),
      IsTruncated: false,
    }
  }

  #nextEtag(): string {
    this.#version += 1
    return `"fake-${this.#version}"`
  }
}

/**
 * Collects the request bodies accepted by the provider without SDK transport.
 */
async function collectBody(body: unknown): Promise<Buffer> {
  if (typeof body === "string") {
    return Buffer.from(body)
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body)
  }

  if (body !== null && typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Buffer[] = []

    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    return Buffer.concat(chunks)
  }

  throw new TypeError("Unsupported fake S3 request body")
}

function requireKey(key: string | undefined): string {
  if (key === undefined) {
    throw new TypeError("Fake S3 command omitted Key")
  }

  return key
}

function preconditionFailure(): Error {
  return Object.assign(new Error("Precondition failed"), {
    $metadata: { httpStatusCode: 412 },
    name: "PreconditionFailed",
  })
}

function missingObject(): Error {
  return Object.assign(new Error("Object not found"), {
    $metadata: { httpStatusCode: 404 },
    name: "NoSuchKey",
  })
}
