import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3"

import {
  Agent,
  AmlRuntime,
  codexAgent,
  createConsoleTracer,
  daytonaSandbox,
  dockerSandbox,
  Sandbox,
  Script,
  s3Workspace,
  Workspace,
} from "../../src/index.js"

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"))
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw error
  }
}

const bucket = requireEnvironment("R2_BUCKET", "AML_S3_BUCKET")
const endpoint = requireEnvironment("R2_ENDPOINT", "AML_S3_ENDPOINT")
const accessKeyId = requireEnvironment("R2_ACCESS_KEY_ID", "AML_S3_ACCESS_KEY_ID")
const secretAccessKey = requireEnvironment("R2_SECRET_ACCESS_KEY", "AML_S3_SECRET_ACCESS_KEY")
const daytonaApiKey = requireEnvironment("DAYTONA_API_KEY")
const codexApiKey = process.env.AML_CODEX_API_KEY ?? process.env.OPENAI_API_KEY

if (codexApiKey === undefined) {
  throw new Error("Workspace S3 smoke requires AML_CODEX_API_KEY or OPENAI_API_KEY")
}

const workspaceId = `s3-chain-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}`
const prefix = process.env.R2_PREFIX ?? process.env.AML_S3_PREFIX ?? "aml/smoke/workspaces"
const objectRoot = `${prefix}/${workspaceId}`
const originalContent = `original-${randomUUID()}`
const dockerContent = `docker-${randomUUID()}`
const finalContent = `${originalContent}${dockerContent}`
const client = new S3Client({
  credentials: { accessKeyId, secretAccessKey },
  endpoint,
  region: process.env.R2_REGION ?? process.env.AML_S3_REGION ?? "auto",
})
const workspaceProvider = s3Workspace({ bucket, client, prefix })
const agent = codexAgent({
  apiKey: codexApiKey,
  ...(process.env.AML_CODEX_BASE_URL === undefined ? {} : { env: { OPENAI_BASE_URL: process.env.AML_CODEX_BASE_URL } }),
})

/**
 * Exercises the complete durable Workspace transfer chain:
 * R2 -> host staging -> Docker -> host staging -> Daytona -> host staging -> R2.
 */
async function main(): Promise<void> {
  const startedAt = performance.now()

  console.log(`[workspace-smoke:start] bucket=${bucket} workspace=${workspaceId}`)
  console.log(`[workspace-smoke:objects] s3://${bucket}/${objectRoot}/`)

  try {
    await seedOriginalWorkspace()

    const runtime = new AmlRuntime({ agentProvider: agent })
    runtime.on(
      "trace",
      createConsoleTracer({
        write: line => console.log(`[workspace-smoke:trace] ${line}`),
      })
    )

    const response = await runtime.evaluate(
      <Workspace id={workspaceId} provider={workspaceProvider} save>
        <Sandbox access="read-write" provider={dockerSandbox({ image: "node:22-alpine" })}>
          <Script shell="node">
            {`import { writeFileSync } from "node:fs"; writeFileSync("docker.txt", ${JSON.stringify(dockerContent)}); console.log("docker.txt written")`}
          </Script>
        </Sandbox>
        <Sandbox
          access="read-write"
          provider={daytonaSandbox({
            config: { apiKey: daytonaApiKey },
            setup: "test -f original.txt && test -f docker.txt && command -v codex",
          })}
        >
          <Agent model={process.env.AML_CODEX_MODEL ?? "gpt-5.3-codex"}>
            Concatenate original.txt and docker.txt byte-for-byte, in that order, into final.txt. Do not insert
            separators or newlines. Do not create, delete, or modify any other Workspace file. After verifying the
            command succeeded, reply with exactly: done
          </Agent>
        </Sandbox>
      </Workspace>,
      { signal: AbortSignal.timeout(300_000) }
    )

    assert.match(response, /\bdone\b/i, "Daytona Agent did not report completion")
    await verifyRestoredWorkspace()

    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${objectRoot}/`,
      })
    )
    const keys = listed.Contents?.flatMap(object => (object.Key === undefined ? [] : [object.Key])) ?? []

    assert(
      keys.some(key => key === `${objectRoot}/workspace.json`),
      "R2 Workspace index was not persisted"
    )
    assert(
      keys.some(key => key.startsWith(`${objectRoot}/revisions/`)),
      "R2 Workspace revision was not persisted"
    )
    console.log(`[workspace-smoke:proof] restoredFiles=original.txt,docker.txt,final.txt objects=${keys.length}`)
    for (const key of keys.sort()) {
      console.log(`[workspace-smoke:object] s3://${bucket}/${key}`)
    }
    console.log(
      `[workspace-smoke:success] workspace=${workspaceId} durationMs=${Math.round(performance.now() - startedAt)}`
    )
  } finally {
    client.destroy()
  }
}

/**
 * Publishes the source file as the initial durable Workspace revision.
 */
async function seedOriginalWorkspace(): Promise<void> {
  const lease = await workspaceProvider.acquire({
    evaluationId: `seed-${randomUUID()}`,
    id: workspaceId,
    signal: AbortSignal.timeout(60_000),
  })

  try {
    await writeFile(path.join(lease.directory, "original.txt"), originalContent, { flag: "wx" })
    await lease.save()
  } finally {
    await lease.release()
  }
}

/**
 * Reacquires from S3 so assertions cannot accidentally inspect host staging.
 */
async function verifyRestoredWorkspace(): Promise<void> {
  const lease = await workspaceProvider.acquire({
    evaluationId: `verify-${randomUUID()}`,
    id: workspaceId,
    signal: AbortSignal.timeout(60_000),
  })

  try {
    const entries = await readdir(lease.directory, { withFileTypes: true })
    const names = entries.map(entry => entry.name).sort()

    assert(
      entries.every(entry => entry.isFile()),
      "Restored Workspace contains an unexpected directory or link"
    )
    assert.deepEqual(names, ["docker.txt", "final.txt", "original.txt"])
    assert.equal(await readFile(path.join(lease.directory, "original.txt"), "utf8"), originalContent)
    assert.equal(await readFile(path.join(lease.directory, "docker.txt"), "utf8"), dockerContent)
    assert.equal(await readFile(path.join(lease.directory, "final.txt"), "utf8"), finalContent)
  } finally {
    await lease.release()
  }
}

function requireEnvironment(...names: string[]): string {
  const value = names.map(name => process.env[name]).find(candidate => candidate !== undefined && candidate.length > 0)

  if (value === undefined) {
    throw new Error(`Workspace S3 smoke requires ${names.join(" or ")}`)
  }

  return value
}

await main()
