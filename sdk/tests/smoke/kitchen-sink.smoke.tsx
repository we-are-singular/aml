import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { S3Client } from "@aws-sdk/client-s3"
import { z } from "zod"

import {
  Agent,
  AmlRuntime,
  createConsoleTracer,
  defineMcpServer,
  defineTool,
  evaluate,
  File,
  FollowUp,
  localWorkspace,
  Mcp,
  Parallel,
  Sandbox,
  Script,
  Skill,
  System,
  Tool,
  Workspace,
  s3Workspace,
  type AmlMcpServer,
  type AmlTool,
  type AmlTraceEvent,
  type TraceSink,
  type WorkspaceProvider,
} from "../../src/index.js"

import {
  KITCHEN_SINK_MCP_NAMES,
  KITCHEN_SINK_WORKSPACE_NAMES,
  loadSmokeEnvironment,
  parseKitchenSinkCommand,
  SMOKE_AGENTS,
  SMOKE_AGENT_NAMES,
  SMOKE_SANDBOXES,
  SMOKE_SANDBOX_NAMES,
  type KitchenSinkMcpName,
  type KitchenSinkSelection,
  type KitchenSinkWorkspaceName,
  type SmokeAgentInstance,
} from "./smoke-config.js"

loadSmokeEnvironment()

interface KitchenSinkProofs {
  readonly childAgent: string
  readonly command: string
  readonly input: string
  readonly nestedAgent: string
  readonly shell: string
  readonly tool: string
}

interface KitchenSinkWorkspace {
  readonly close: () => Promise<void>
  readonly location: string
  readonly provider: WorkspaceProvider
}

interface KitchenSinkAgentProps {
  readonly mcp: AmlMcpServer | undefined
  readonly model: string
  readonly proofs: KitchenSinkProofs
  readonly proofTool: AmlTool
}

const command = parseKitchenSinkCommand(process.argv.slice(2))

if (command.kind === "help") {
  console.log(
    [
      "Usage: npm run smoke:kitchen-sink -- [options]",
      "",
      `Agents: ${SMOKE_AGENT_NAMES.join(", ")}`,
      `Sandboxes: ${SMOKE_SANDBOX_NAMES.join(", ")}`,
      `Workspaces: ${KITCHEN_SINK_WORKSPACE_NAMES.join(", ")}`,
      `MCP: ${KITCHEN_SINK_MCP_NAMES.join(", ")}`,
      "",
      "Defaults: --agent opencode --sandbox modal --workspace r2 --mcp context7",
    ].join("\n")
  )
} else {
  await runKitchenSink(command.selection)
}

/**
 * Runs all stable AML primitives through one remote-capable composed workflow.
 */
async function runKitchenSink(selection: KitchenSinkSelection): Promise<void> {
  const startedAt = performance.now()
  const workspaceId = `kitchen-sink-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}`
  const proofs: KitchenSinkProofs = {
    childAgent: `child-agent-${randomUUID()}`,
    command: `command-${randomUUID()}`,
    input: `input-${randomUUID()}`,
    nestedAgent: `nested-agent-${randomUUID()}`,
    shell: `shell-${randomUUID()}`,
    tool: `tool-${randomUUID()}`,
  }
  const proofTool = defineTool({
    description: "Return the private proof for this kitchen-sink invocation.",
    input: z.object({}),
    name: "aml_kitchen_sink_proof",
    execute: async () => proofs.tool,
  })
  const mcp = createMcp(selection.mcp)
  const workspace = await createWorkspace(selection.workspace, workspaceId)
  const agentRegistration = SMOKE_AGENTS[selection.agent]
  let agent: SmokeAgentInstance | undefined

  try {
    agent = agentRegistration.create()
    const sandboxRegistration = SMOKE_SANDBOXES[selection.sandbox]
    const sandbox = sandboxRegistration.create()
    const traceEvents: AmlTraceEvent[] = []
    const traceCapture = ((event: AmlTraceEvent) => traceEvents.push(event)) as TraceSink
    Object.defineProperty(traceCapture, "captureContent", { value: true })

    console.log(
      `[kitchen-sink:start] agent=${selection.agent} model=${agentRegistration.model} sandbox=${selection.sandbox} environment=${sandboxRegistration.environment} workspace=${selection.workspace} mcp=${selection.mcp}`
    )
    console.log(`[kitchen-sink:workspace] id=${workspaceId} location=${workspace.location}`)

    const runtime = new AmlRuntime({
      agentProvider: agent.provider,
      allowedMcpServers: mcp === undefined ? [] : [mcp.name],
      allowedTools: [proofTool.name],
      maxAgentCalls: 4,
      maxConcurrentAgents: 1,
      maxTurnsPerAgent: 2,
    })
    runtime.on("trace", traceCapture)
    runtime.on(
      "trace",
      createConsoleTracer({
        write: line => console.log(`[kitchen-sink:trace] ${line}`),
      })
    )

    await runtime.evaluate(
      <Workspace id={workspaceId} load={false} provider={workspace.provider} save={{ retention: 1 }}>
        <File path="input.txt">{proofs.input}</File>
        <File path="result.json">
          <Sandbox access="read-write" provider={sandbox}>
            <KitchenSinkAgent mcp={mcp} model={agentRegistration.model} proofs={proofs} proofTool={proofTool} />
          </Sandbox>
        </File>
      </Workspace>,
      { signal: AbortSignal.timeout(600_000) }
    )

    await verifyPersistedWorkspace(workspace.provider, workspaceId, proofs, selection.mcp)

    if (selection.mcp === "context7") {
      assert(traceEvents.some(isContext7ToolCall), "Context7 was attached but no Context7 MCP Tool call was observed")
    }
  } catch (error) {
    console.error(
      `[kitchen-sink:failure] workspace=${workspaceId} durationMs=${Math.round(performance.now() - startedAt)} error=${error instanceof Error ? error.message : String(error)}`
    )
    throw error
  } finally {
    try {
      await agent?.release?.()
    } finally {
      await workspace.close()
    }
  }

  console.log(
    `\n✅ Kitchen-sink smoke completed successfully. workspace=${workspaceId} persisted=input.txt,command.txt,shell.txt,result.json mcp=${selection.mcp} durationMs=${Math.round(performance.now() - startedAt)}`
  )
}

/**
 * Composes scripts, nested Agents, capabilities, and a same-session FollowUp.
 */
async function KitchenSinkAgent({ mcp, model, proofs, proofTool }: KitchenSinkAgentProps) {
  const expectedMcp = mcp === undefined ? "skipped" : "context7"
  const parallelProof = await evaluate(
    <Parallel>
      <NestedRemoteProof model={model} proofs={proofs} />
      <InputFileProof proofs={proofs} />
    </Parallel>
  )
  assert.equal(
    parallelProof.trim(),
    `${proofs.nestedAgent}input-ok`,
    "Parallel composition returned proofs outside authored order"
  )
  const nestedAgent = proofs.nestedAgent
  const Result = z.object({
    command: z.literal(proofs.command),
    input: z.literal(proofs.input),
    mcp: z.literal(expectedMcp),
    nestedAgent: z.literal(proofs.nestedAgent),
    shell: z.literal(proofs.shell),
    status: z.literal("passed"),
    tool: z.literal(proofs.tool),
  })

  const result = await evaluate(
    <Agent model={model} system="Complete the remote AML smoke proof without inventing evidence.">
      <KitchenSinkCapabilities mcp={mcp} proofTool={proofTool} />
      <System>
        A preceding nested-Agent composition verified the remote Workspace files and returned this private proof:{" "}
        {nestedAgent}
      </System>
      Inspect the same three Workspace files with your native filesystem tools. Call aml_kitchen_sink_proof.{" "}
      {mcp === undefined
        ? "The MCP check is explicitly disabled for this run."
        : "Use the Context7 MCP tools to resolve the Zod library and query its documentation for schema parsing."}
      Do not modify any Workspace file.
      <FollowUp>
        Recheck the evidence from this session, then submit the structured result. Set mcp to {expectedMcp}.
      </FollowUp>
    </Agent>,
    Result
  )

  return `${JSON.stringify(result, null, 2)}\n`
}

function NestedRemoteProof({ model, proofs }: Pick<KitchenSinkAgentProps, "model" | "proofs">) {
  return (
    <Agent model={model} system="Coordinate one remote filesystem proof.">
      Command Script proof: <CommandProof proofs={proofs} />
      Shell Script proof: <ShellProof proofs={proofs} />
      <System>Trust only the Script output and the nested Agent's direct Workspace inspection.</System>
      Nested Agent proof:
      <Agent model={model}>
        Read input.txt, command.txt, and shell.txt. Confirm their exact contents are respectively {proofs.input},{" "}
        {proofs.command}, and {proofs.shell}. Do not modify any file. After verification, reply with exactly:{" "}
        {proofs.childAgent}
      </Agent>
      Confirm the nested Agent returned exactly {proofs.childAgent}, then reply with exactly: {proofs.nestedAgent}
    </Agent>
  )
}

function KitchenSinkCapabilities({ mcp, proofTool }: Pick<KitchenSinkAgentProps, "mcp" | "proofTool">) {
  return (
    <>
      <Tool use={proofTool} />
      {mcp === undefined ? null : <Mcp use={mcp} />}
      <Skill name="Kitchen sink evidence" description="Rules for this manual integration proof">
        Use the granted capabilities and remote Workspace evidence. Never guess a private proof value or report a check
        as passed before observing it.
      </Skill>
    </>
  )
}

function CommandProof({ proofs }: Readonly<{ proofs: KitchenSinkProofs }>) {
  const source = [
    'import { readFileSync, writeFileSync } from "node:fs";',
    `const input = readFileSync("input.txt", "utf8");`,
    `if (input !== ${JSON.stringify(proofs.input)}) throw new Error("unexpected input.txt");`,
    `writeFileSync("command.txt", ${JSON.stringify(proofs.command)});`,
    `process.stdout.write(${JSON.stringify(proofs.command)});`,
  ].join("")

  return <Script command="node" args={["--input-type=module", "--eval", source]} />
}

function ShellProof({ proofs }: Readonly<{ proofs: KitchenSinkProofs }>) {
  return (
    <Script shell="node">
      {`import { readFileSync, writeFileSync } from "node:fs";
if (readFileSync("input.txt", "utf8") !== ${JSON.stringify(proofs.input)}) throw new Error("unexpected input.txt");
if (readFileSync("command.txt", "utf8") !== ${JSON.stringify(proofs.command)}) throw new Error("unexpected command.txt");
writeFileSync("shell.txt", ${JSON.stringify(proofs.shell)});
process.stdout.write(${JSON.stringify(proofs.shell)});`}
    </Script>
  )
}

function InputFileProof({ proofs }: Readonly<{ proofs: KitchenSinkProofs }>) {
  const source = [
    'import { readFileSync } from "node:fs";',
    `if (readFileSync("input.txt", "utf8") !== ${JSON.stringify(proofs.input)}) throw new Error("unexpected input.txt");`,
    'process.stdout.write("input-ok");',
  ].join("")

  return <Script command="node" args={["--input-type=module", "--eval", source]} />
}

function createMcp(name: KitchenSinkMcpName): AmlMcpServer | undefined {
  if (name === "none") return undefined

  const apiKey = process.env.CONTEXT7_API_KEY
  return defineMcpServer({
    name: "context7",
    transport: {
      ...(apiKey === undefined ? {} : { headers: { CONTEXT7_API_KEY: apiKey } }),
      type: "streamable-http",
      url: "https://mcp.context7.com/mcp",
    },
  })
}

async function createWorkspace(name: KitchenSinkWorkspaceName, workspaceId: string): Promise<KitchenSinkWorkspace> {
  if (name === "local") {
    const directory = await mkdtemp(path.join(os.tmpdir(), "aml-kitchen-sink-"))
    return {
      close: async () => await rm(directory, { force: true, recursive: true }),
      location: directory,
      provider: localWorkspace({ directory }),
    }
  }

  const bucket = requireEnvironment("R2_BUCKET", "AML_S3_BUCKET")
  const endpoint = requireEnvironment("R2_ENDPOINT", "AML_S3_ENDPOINT")
  const accessKeyId = requireEnvironment("R2_ACCESS_KEY_ID", "AML_S3_ACCESS_KEY_ID")
  const secretAccessKey = requireEnvironment("R2_SECRET_ACCESS_KEY", "AML_S3_SECRET_ACCESS_KEY")
  const prefix = process.env.R2_PREFIX ?? process.env.AML_S3_PREFIX ?? "aml/smoke/workspaces"
  const client = new S3Client({
    credentials: { accessKeyId, secretAccessKey },
    endpoint,
    region: process.env.R2_REGION ?? process.env.AML_S3_REGION ?? "auto",
  })

  return {
    close: async () => client.destroy(),
    location: `s3://${bucket}/${prefix}/${workspaceId}/`,
    provider: s3Workspace({ bucket, client, prefix }),
  }
}

/**
 * Reacquires the published revision so assertions cannot see first-run staging.
 */
async function verifyPersistedWorkspace(
  provider: WorkspaceProvider,
  workspaceId: string,
  proofs: KitchenSinkProofs,
  mcp: KitchenSinkMcpName
): Promise<void> {
  const lease = await provider.acquire({
    evaluationId: `verify-${randomUUID()}`,
    id: workspaceId,
    load: { exclude: [], revision: "current" },
    lock: true,
    signal: AbortSignal.timeout(120_000),
  })

  try {
    assert.equal(await readFile(path.join(lease.directory, "input.txt"), "utf8"), proofs.input)
    assert.equal(await readFile(path.join(lease.directory, "command.txt"), "utf8"), proofs.command)
    assert.equal(await readFile(path.join(lease.directory, "shell.txt"), "utf8"), proofs.shell)
    assert.deepEqual(JSON.parse(await readFile(path.join(lease.directory, "result.json"), "utf8")), {
      command: proofs.command,
      input: proofs.input,
      mcp: mcp === "none" ? "skipped" : "context7",
      nestedAgent: proofs.nestedAgent,
      shell: proofs.shell,
      status: "passed",
      tool: proofs.tool,
    })
    console.log(`[kitchen-sink:proof] workspace=${workspaceId} reacquired=true contents=verified`)
  } finally {
    await lease.release()
  }
}

function isContext7ToolCall(event: AmlTraceEvent): boolean {
  if (event.type !== "event" || event.name !== "acp.session.update" || event.attributes.sessionUpdate !== "tool_call") {
    return false
  }

  const update = event.attributes.update
  return typeof update === "string" && /context7|resolve[-_ ]library|query[-_ ]docs/i.test(update)
}

function requireEnvironment(...names: string[]): string {
  const value = names.map(name => process.env[name]).find(candidate => candidate !== undefined && candidate.length > 0)
  if (value === undefined) throw new Error(`Kitchen-sink smoke requires ${names.join(" or ")}`)
  return value
}
