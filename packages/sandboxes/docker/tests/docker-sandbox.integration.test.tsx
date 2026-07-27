import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import Dockerode from "dockerode"
import { describe, expect, it } from "vitest"

import {
  Agent,
  AmlRuntime,
  Sandbox,
  type AgentExecutionContext,
  type AgentProvider,
  type AgentRequest,
  type SandboxSession,
} from "@aml/sdk"

import {
  dockerSandbox,
  supportsDockerSandbox,
  type DockerCommandResult,
  type DockerSandboxHandle,
} from "../src/index.js"

interface IsolationProbe {
  readonly access: "read-only" | "read-write"
  readonly capabilities: string
  readonly fixture: string
  readonly hostSiblingHidden: boolean
  readonly networkDisabled: boolean
  readonly nonRoot: boolean
  readonly rootMountReadOnly: boolean
  readonly workspaceWriteSucceeded: boolean
}

const dockerEnabled = process.env.AML_DOCKER_TEST === "1"

describe.skipIf(!dockerEnabled)("Docker Sandbox integration", () => {
  it("confines both access modes and removes their containers", async () => {
    const temporary = await createIntegrationWorkspace()
    const repository = path.join(temporary, "repository")
    const client = new Dockerode()
    const provider = dockerSandbox({
      client,
      image: process.env.AML_DOCKER_IMAGE ?? "alpine:3.22",
      workspace: temporary,
    })
    const containerIds: string[] = []

    try {
      const readOnly = await runProbe(
        "read-only",
        provider,
        containerIds,
      )
      const readWrite = await runProbe(
        "read-write",
        provider,
        containerIds,
      )

      expect(readOnly).toMatchObject({
        access: "read-only",
        capabilities: "0000000000000000",
        fixture: "sandbox fixture",
        hostSiblingHidden: true,
        networkDisabled: true,
        nonRoot: true,
        rootMountReadOnly: true,
        workspaceWriteSucceeded: false,
      })
      expect(readWrite).toMatchObject({
        access: "read-write",
        capabilities: "0000000000000000",
        fixture: "sandbox fixture",
        hostSiblingHidden: true,
        networkDisabled: true,
        nonRoot: true,
        rootMountReadOnly: true,
        workspaceWriteSucceeded: true,
      })
      await expect(
        readFile(path.join(repository, "write-proof.txt"), "utf8"),
      ).resolves.toBe("sandbox-write")

      for (const containerId of containerIds) {
        await expect(
          client.getContainer(containerId).inspect(),
        ).rejects.toMatchObject({ statusCode: 404 })
      }
    } finally {
      await cleanupContainers(client, containerIds)
      await rm(temporary, { force: true, recursive: true })
    }
  }, 180_000)

  it("cancels an active command and removes its container", async () => {
    const temporary = await createIntegrationWorkspace()
    const client = new Dockerode()
    const provider = dockerSandbox({
      client,
      image: process.env.AML_DOCKER_IMAGE ?? "alpine:3.22",
      workspace: temporary,
    })
    const controller = new AbortController()
    const cancellation = new Error("cancel Docker Agent")
    const containerIds: string[] = []
    let commandStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      commandStarted = resolve
    })
    const agentProvider: AgentProvider = {
      name: "docker-cancellation-probe",
      async run(
        _request: AgentRequest,
        context: AgentExecutionContext,
      ) {
        const sandbox = requireDockerSandbox(context.sandbox)
        containerIds.push(sandbox.lease.handle.containerId)
        commandStarted?.()
        await sandbox.lease.handle.exec(
          ["sh", "-c", "sleep 60"],
          {
            cwd: sandbox.cwd,
            signal: context.signal,
          },
        )
        return { text: "unexpected completion" }
      },
      supportsSandbox: supportsDockerSandbox,
    }

    try {
      const pending = new AmlRuntime({ agentProvider }).evaluate(
        <Sandbox provider={provider} root="repository">
          <Agent>Wait until cancelled.</Agent>
        </Sandbox>,
        { signal: controller.signal },
      )

      await started
      controller.abort(cancellation)
      const error = await pending.catch((cause: unknown) => cause)

      // Agent failures remain attributable at the AML boundary while the
      // caller's exact cancellation reason is preserved as their cause.
      expect(error).toMatchObject({ cause: cancellation })

      expect(containerIds).toHaveLength(1)
      await expect(
        client.getContainer(containerIds[0]!).inspect(),
      ).rejects.toMatchObject({ statusCode: 404 })
    } finally {
      await cleanupContainers(client, containerIds)
      await rm(temporary, { force: true, recursive: true })
    }
  }, 180_000)

  it("executes in the effective Agent-local cwd", async () => {
    const temporary = await createIntegrationWorkspace()
    const client = new Dockerode()
    const provider = dockerSandbox({
      client,
      image: process.env.AML_DOCKER_IMAGE ?? "alpine:3.22",
      workspace: temporary,
    })
    const containerIds: string[] = []
    const agentProvider: AgentProvider = {
      name: "docker-cwd-probe",
      async run(
        _request: AgentRequest,
        context: AgentExecutionContext,
      ) {
        const sandbox = requireDockerSandbox(context.sandbox)
        containerIds.push(sandbox.lease.handle.containerId)
        const result = await sandbox.lease.handle.exec(["pwd"], {
          cwd: sandbox.cwd,
          signal: context.signal,
        })
        return { text: result.stdout.trim() }
      },
      supportsSandbox: supportsDockerSandbox,
    }

    try {
      const output = await new AmlRuntime({
        agentProvider,
      }).evaluate(
        <Sandbox provider={provider} root="repository">
          <Agent cwd="nested">Report the working directory.</Agent>
        </Sandbox>,
      )

      expect(output).toBe("/workspace/nested")
    } finally {
      await cleanupContainers(client, containerIds)
      await rm(temporary, { force: true, recursive: true })
    }
  }, 180_000)

  it("builds a configured Dockerfile before acquiring its lease", async () => {
    const temporary = await createIntegrationWorkspace()
    const client = new Dockerode()
    const provider = dockerSandbox({
      buildContext: temporary,
      client,
      dockerfile: path.join(temporary, "Dockerfile"),
      workspace: temporary,
    })
    let containerId: string | undefined

    try {
      const lease = await provider.acquire({
        access: "read-only",
        cwd: "repository",
        evaluationId: "docker-build-integration",
        root: "repository",
        signal: new AbortController().signal,
      })
      containerId = lease.id
      const fixture = await expectSuccess(
        lease.handle.exec(["cat", "fixture.txt"], {
          cwd: "repository",
        }),
        "read fixture from built image",
      )

      expect(fixture.stdout.trim()).toBe("sandbox fixture")
      await lease.release()
      await expect(
        client.getContainer(containerId).inspect(),
      ).rejects.toMatchObject({ statusCode: 404 })
    } finally {
      await cleanupContainers(
        client,
        containerId === undefined ? [] : [containerId],
      )
      await rm(temporary, { force: true, recursive: true })
    }
  }, 180_000)

  it("does not cache a failed Engine build", async () => {
    const temporary = await createIntegrationWorkspace()
    const dockerfile = path.join(temporary, "Dockerfile")
    const client = new Dockerode()
    const provider = dockerSandbox({
      buildContext: temporary,
      client,
      dockerfile,
      workspace: temporary,
    })
    let containerId: string | undefined

    try {
      await writeFile(
        dockerfile,
        `FROM ${process.env.AML_DOCKER_IMAGE ?? "alpine:3.22"}\nRUN exit 19\n`,
      )
      await expect(
        provider.acquire({
          access: "read-only",
          cwd: "repository",
          evaluationId: "docker-failed-build-integration",
          root: "repository",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("Docker Sandbox image build failed")

      await writeFile(
        dockerfile,
        `FROM ${process.env.AML_DOCKER_IMAGE ?? "alpine:3.22"}\n`,
      )
      const lease = await provider.acquire({
        access: "read-only",
        cwd: "repository",
        evaluationId: "docker-build-retry-integration",
        root: "repository",
        signal: new AbortController().signal,
      })
      containerId = lease.id
      await lease.release()
    } finally {
      await cleanupContainers(
        client,
        containerId === undefined ? [] : [containerId],
      )
      await rm(temporary, { force: true, recursive: true })
    }
  }, 180_000)
})

/**
 * Agent provider that probes only the Docker capability supplied by AML.
 */
class DockerProbeAgent implements AgentProvider {
  readonly name = "docker-isolation-probe"

  /**
   * Captures the access mode and released-container evidence for one run.
   */
  constructor(
    private readonly access: "read-only" | "read-write",
    private readonly containerIds: string[],
  ) {}

  /**
   * Confirms that this provider knows how to use the Docker handle.
   */
  supportsSandbox(
    sandbox: SandboxSession,
  ): sandbox is SandboxSession<DockerSandboxHandle> {
    return supportsDockerSandbox(sandbox)
  }

  /**
   * Executes deterministic confinement probes inside the active container.
   */
  async run(
    _request: AgentRequest,
    context: AgentExecutionContext,
  ) {
    const sandbox = requireDockerSandbox(context.sandbox)
    const handle = sandbox.lease.handle
    this.containerIds.push(handle.containerId)
    const fixture = await expectSuccess(
      handle.exec(["cat", "fixture.txt"], {
        cwd: sandbox.cwd,
        signal: context.signal,
      }),
      "read fixture",
    )
    const uid = await expectSuccess(
      handle.exec(["id", "-u"], {
        cwd: sandbox.cwd,
        signal: context.signal,
      }),
      "read uid",
    )
    const capabilities = await expectSuccess(
      handle.exec(
        [
          "sh",
          "-c",
          "awk '/CapEff/ {print $2}' /proc/self/status",
        ],
        {
          cwd: sandbox.cwd,
          signal: context.signal,
        },
      ),
      "read capabilities",
    )
    const network = await handle.exec(
      ["sh", "-c", "test ! -e /sys/class/net/eth0"],
      {
        cwd: sandbox.cwd,
        signal: context.signal,
      },
    )
    const hostSibling = await handle.exec(
      [
        "sh",
        "-c",
        "test ! -e /host-secret.txt && test ! -e /var/run/docker.sock",
      ],
      {
        cwd: sandbox.cwd,
        signal: context.signal,
      },
    )
    const rootMount = await expectSuccess(
      handle.exec(
        [
          "sh",
          "-c",
          "awk '$2 == \"/\" { print $4 }' /proc/mounts",
        ],
        {
          cwd: sandbox.cwd,
          signal: context.signal,
        },
      ),
      "read root mount",
    )
    const workspaceWrite = await handle.exec(
      [
        "sh",
        "-c",
        "printf sandbox-write > write-proof.txt",
      ],
      {
        cwd: sandbox.cwd,
        signal: context.signal,
      },
    )
    const probe: IsolationProbe = {
      access: this.access,
      capabilities: capabilities.stdout.trim(),
      fixture: fixture.stdout.trim(),
      hostSiblingHidden: hostSibling.exitCode === 0,
      networkDisabled: network.exitCode === 0,
      nonRoot: uid.stdout.trim() !== "0",
      rootMountReadOnly: rootMount.stdout
        .trim()
        .split(",")
        .includes("ro"),
      workspaceWriteSucceeded: workspaceWrite.exitCode === 0,
    }

    return { text: JSON.stringify(probe) }
  }
}

/**
 * Runs one access-mode probe through the public AML and Docker packages.
 */
async function runProbe(
  access: "read-only" | "read-write",
  provider: ReturnType<typeof dockerSandbox>,
  containerIds: string[],
): Promise<IsolationProbe> {
  const agentProvider = new DockerProbeAgent(access, containerIds)
  const output = await new AmlRuntime({ agentProvider }).evaluate(
    <Sandbox
      access={access}
      provider={provider}
      root="repository"
    >
      <Agent>Run the Docker isolation probe.</Agent>
    </Sandbox>,
  )

  return JSON.parse(output) as IsolationProbe
}

/**
 * Narrows an Agent execution context to the Docker-specific opaque handle.
 */
function requireDockerSandbox(
  sandbox: SandboxSession | undefined,
): SandboxSession<DockerSandboxHandle> {
  if (sandbox === undefined || !supportsDockerSandbox(sandbox)) {
    throw new Error("Docker probe requires a compatible Sandbox")
  }

  return sandbox
}

/**
 * Requires a successful container command while preserving its output.
 */
async function expectSuccess(
  pending: Promise<DockerCommandResult>,
  operation: string,
): Promise<DockerCommandResult> {
  const result = await pending

  if (result.exitCode !== 0) {
    throw new Error(
      `${operation} failed: ${result.stderr || result.stdout}`,
    )
  }

  return result
}

/**
 * Creates one host tree whose sibling must never enter the container.
 */
async function createIntegrationWorkspace(): Promise<string> {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "aml-docker-integration-"),
  )
  const repository = path.join(temporary, "repository")
  await mkdir(path.join(repository, "nested"), {
    recursive: true,
  })
  await writeFile(
    path.join(repository, "fixture.txt"),
    "sandbox fixture",
  )
  await writeFile(
    path.join(temporary, "host-secret.txt"),
    "must stay outside the mount",
  )
  await writeFile(
    path.join(temporary, "Dockerfile"),
    `FROM ${process.env.AML_DOCKER_IMAGE ?? "alpine:3.22"}\n`,
  )
  return temporary
}

/**
 * Best-effort test cleanup for containers left by an assertion failure.
 */
async function cleanupContainers(
  client: Dockerode,
  containerIds: readonly string[],
): Promise<void> {
  await Promise.all(
    containerIds.map(
      async (containerId) => {
        try {
          await client.getContainer(containerId).remove({ force: true })
        } catch (error) {
          // Integration cleanup is idempotent because the runtime should have
          // already removed every container under test.
          if (
            typeof error !== "object" ||
            error === null ||
            !("statusCode" in error) ||
            error.statusCode !== 404
          ) {
            throw error
          }
        }
      },
    ),
  )
}
