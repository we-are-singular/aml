import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { CreateBucketCommand, DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { workspaceProviderConformance } from "@aml-jsx/sdk/testing"
import { AmlRuntime, Sandbox, Script, Workspace } from "@aml-jsx/sdk"
import { localSandbox } from "@aml-jsx/sandbox-local"

import { s3Workspace } from "../src/index.js"

const bucket = process.env.AML_S3_BUCKET ?? "aml-workspace-integration"
const prefix = `integration/${crypto.randomUUID()}`
const client = new S3Client({
  credentials: {
    accessKeyId: process.env.AML_S3_ACCESS_KEY_ID ?? "aml-minio",
    secretAccessKey: process.env.AML_S3_SECRET_ACCESS_KEY ?? "aml-minio-secret",
  },
  endpoint: process.env.AML_S3_ENDPOINT ?? "http://127.0.0.1:19000",
  forcePathStyle: true,
  region: process.env.AML_S3_REGION ?? "us-east-1",
})

describe.skipIf(process.env.AML_S3_TEST !== "1")("s3Workspace() with MinIO", () => {
  beforeAll(async () => {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }))
    } catch (error) {
      if (!isExistingBucket(error)) {
        throw error
      }
    }
  })

  afterAll(async () => {
    await deletePrefix()
    client.destroy()
  })

  it("persists through the real S3-compatible API", async () => {
    const provider = s3Workspace({ bucket, client, prefix })
    const request = {
      evaluationId: "minio-round-trip-first",
      id: "repository",
      signal: new AbortController().signal,
    }
    const first = await provider.acquire(request)

    await writeFile(path.join(first.directory, "minio.txt"), "durable")
    await first.save()
    await first.release()

    const second = await provider.acquire({
      ...request,
      evaluationId: "minio-round-trip-second",
    })

    await expect(readFile(path.join(second.directory, "minio.txt"), "utf8")).resolves.toBe("durable")
    await second.release()
  })

  it("persists files produced by Script through the complete Workspace lifecycle", async () => {
    const provider = s3Workspace({ bucket, client, prefix: `${prefix}/script` })
    const seed = await provider.acquire({
      evaluationId: "minio-script-seed",
      id: "script",
      signal: new AbortController().signal,
    })

    await mkdir(path.join(seed.directory, "repo"))
    await seed.save()
    await seed.release()

    await new AmlRuntime().evaluate(
      <Workspace cwd="repo" id="script" provider={provider} save>
        <Sandbox access="read-write" provider={localSandbox()}>
          <Script shell="node">
            {`import { writeFileSync } from "node:fs"; writeFileSync("script-output.txt", "durable script")`}
          </Script>
        </Sandbox>
      </Workspace>
    )

    const restored = await provider.acquire({
      evaluationId: "minio-script-restore",
      id: "script",
      signal: new AbortController().signal,
    })

    await expect(readFile(path.join(restored.directory, "repo", "script-output.txt"), "utf8")).resolves.toBe(
      "durable script"
    )
    await restored.release()
  })

  it("passes Workspace conformance through MinIO conditional writes", async () => {
    await expect(
      workspaceProviderConformance(
        s3Workspace({
          bucket,
          client,
          prefix: `${prefix}/conformance`,
        })
      )
    ).resolves.toBeUndefined()
  })
})

async function deletePrefix(): Promise<void> {
  let continuationToken: string | undefined

  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
        Prefix: prefix,
      })
    )
    const objects = listed.Contents?.flatMap(object => (object.Key === undefined ? [] : [{ Key: object.Key }])) ?? []

    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects },
        })
      )
    }

    continuationToken = listed.NextContinuationToken
  } while (continuationToken !== undefined)
}

function isExistingBucket(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const name = Reflect.get(value, "name")
  const code = Reflect.get(value, "Code") ?? Reflect.get(value, "code")
  return (
    name === "BucketAlreadyOwnedByYou" ||
    name === "BucketAlreadyExists" ||
    code === "BucketAlreadyOwnedByYou" ||
    code === "BucketAlreadyExists"
  )
}
