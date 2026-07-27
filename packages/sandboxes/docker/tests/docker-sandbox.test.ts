import { PassThrough, Readable } from "node:stream"
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import Dockerode from "dockerode"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  SandboxAcquireRequest,
  SandboxLeaseReference,
  SandboxSession,
} from "@aml/sdk"
import { sandboxProviderConformance } from "@aml/sdk/testing"

import {
  dockerSandbox,
  supportsDockerSandbox,
  type DockerSandboxHandle,
} from "../src/index.js"

interface DockerHarness {
  readonly client: Dockerode
  readonly container: Dockerode.Container
  readonly createRequests: Dockerode.ContainerCreateOptions[]
  readonly execRequests: Dockerode.ExecCreateOptions[]
  readonly removeRequests: Dockerode.ContainerRemoveOptions[]
  readonly startRequests: Dockerode.ContainerStartOptions[]
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporaryDirectories.splice(0).map(
      async (directory) =>
        await rm(directory, { force: true, recursive: true }),
    ),
  )
})

describe("dockerSandbox()", () => {
  it("is inert until acquisition and creates a hardened container", async () => {
    const workspace = await createWorkspace()
    const docker = createDockerHarness()
    const provider = dockerSandbox({
      client: docker.client,
      image: "alpine:3.22",
      workspace,
    })

    expect(docker.createRequests).toHaveLength(0)

    const request = rootRequest({
      access: "read-only",
      cwd: "repository/src",
      root: "repository",
    })
    const lease = await provider.acquire(request)
    const create = docker.createRequests[0]
    const mount = create?.HostConfig?.Mounts?.[0]

    expect(create).toMatchObject({
      Entrypoint: ["sh"],
      Image: "alpine:3.22",
      NetworkDisabled: true,
      Tty: false,
      User: expect.any(String),
      WorkingDir: "/workspace/src",
    })
    expect(create?.HostConfig).toMatchObject({
      AutoRemove: true,
      CapDrop: ["ALL"],
      Init: true,
      Memory: 512 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      NetworkMode: "none",
      PidsLimit: 128,
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
    })
    expect(create?.HostConfig?.Tmpfs?.["/tmp"]).toContain(
      `size=${64 * 1024 * 1024}`,
    )
    expect(mount).toMatchObject({
      ReadOnly: true,
      Target: "/workspace",
      Type: "bind",
    })
    expect(mount?.Source).toBe(
      path.join(workspace, "repository"),
    )
    expect(JSON.stringify(create)).not.toContain(
      "/var/run/docker.sock",
    )
    expect(docker.startRequests).toEqual([
      { abortSignal: request.signal },
    ])
    expect(lease.id).toBe("container-123")
    expect(lease.handle).toMatchObject({
      access: "read-only",
      containerId: "container-123",
      kind: "docker",
      root: "repository",
    })

    await lease.release()
    expect(docker.removeRequests).toEqual([{ force: true }])
  })

  it("executes literal arguments and captures multiplexed output", async () => {
    const workspace = await createWorkspace()
    const docker = createDockerHarness({
      exitCode: 7,
      stderr: "warning\n",
      stdout: "hello; still data\n",
    })
    const provider = dockerSandbox({
      client: docker.client,
      image: "alpine:3.22",
      workspace,
    })
    const request = rootRequest({
      access: "read-write",
      root: "repository",
    })
    const lease = await provider.acquire(request)
    const controller = new AbortController()

    const result = await lease.handle.exec(
      ["printf", "%s", "hello; still one argument", ""],
      {
        cwd: "repository/src",
        signal: controller.signal,
      },
    )

    expect(result).toEqual({
      exitCode: 7,
      stderr: "warning\n",
      stdout: "hello; still data\n",
    })
    expect(docker.execRequests.at(-1)).toEqual({
      AttachStderr: true,
      AttachStdout: true,
      Cmd: [
        "printf",
        "%s",
        "hello; still one argument",
        "",
      ],
      Tty: false,
      WorkingDir: "/workspace/src",
      abortSignal: controller.signal,
    })
    expect(
      docker.createRequests[0]?.HostConfig?.Mounts?.[0]?.ReadOnly,
    ).toBe(false)

    await lease.release()
  })

  it("rejects invalid commands, cwd escape, and excessive output", async () => {
    const workspace = await createWorkspace()
    const docker = createDockerHarness({
      stdout: "output exceeds limit",
    })
    const provider = dockerSandbox({
      client: docker.client,
      image: "alpine:3.22",
      maxOutputBytes: 4,
      workspace,
    })
    const lease = await provider.acquire(
      rootRequest({ root: "repository" }),
    )

    await expect(
      lease.handle.exec([], { cwd: "repository" }),
    ).rejects.toThrow(
      "must contain an executable",
    )
    await expect(
      lease.handle.exec([""], { cwd: "repository" }),
    ).rejects.toThrow("contains an invalid argument")
    await expect(
      lease.handle.exec(["pwd"], { cwd: "outside" }),
    ).rejects.toThrow("cwd cannot escape its root")
    await expect(
      lease.handle.exec(["print-lots"], {
        cwd: "repository",
      }),
    ).rejects.toThrow("Docker Sandbox command failed")

    await lease.release()
  })

  it("builds through Dockerode and caches only a successful build", async () => {
    const workspace = await createWorkspace()
    const docker = createDockerHarness()
    let builds = 0
    const buildImage = vi
      .spyOn(docker.client, "buildImage")
      .mockImplementation(async (_context, options) => {
        builds += 1

        if (builds === 1) {
          return Readable.from([
            `${JSON.stringify({
              error: "first build failed",
              errorDetail: { message: "first build failed" },
            })}\n`,
          ])
        }

        expect(options).toMatchObject({
          dockerfile: "Dockerfile",
          networkmode: "none",
          version: "2",
        })
        return Readable.from([
          `${JSON.stringify({ stream: "build complete\n" })}\n`,
        ])
      })
    const provider = dockerSandbox({
      buildContext: workspace,
      client: docker.client,
      dockerfile: path.join(workspace, "Dockerfile"),
      workspace,
    })

    await expect(provider.acquire(rootRequest())).rejects.toThrow(
      "Docker Sandbox image build failed",
    )
    const first = await provider.acquire(rootRequest())
    const second = await provider.acquire(rootRequest())

    expect(buildImage).toHaveBeenCalledTimes(2)
    expect(buildImage.mock.calls[0]?.[0]).toEqual({
      context: workspace,
      src: ["."],
    })
    expect(
      docker.createRequests[0]?.Image,
    ).toMatch(/^aml-sandbox-[a-f0-9-]+:latest$/)
    expect(docker.createRequests[1]?.Image).toBe(
      docker.createRequests[0]?.Image,
    )

    await first.release()
    await second.release()
  })

  it("rejects mount and Dockerfile symlinks that escape their boundaries", async () => {
    const workspace = await createWorkspace()
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "aml-docker-outside-"),
    )
    temporaryDirectories.push(outside)
    await writeFile(
      path.join(outside, "Dockerfile"),
      "FROM alpine:3.22\n",
    )
    await symlink(outside, path.join(workspace, "escape"))
    await symlink(
      path.join(outside, "Dockerfile"),
      path.join(workspace, "Escaping.Dockerfile"),
    )
    const docker = createDockerHarness()

    const imageProvider = dockerSandbox({
      client: docker.client,
      image: "alpine:3.22",
      workspace,
    })
    await expect(
      imageProvider.acquire(
        rootRequest({ cwd: "escape", root: "escape" }),
      ),
    ).rejects.toThrow(
      "Sandbox root resolves outside its configured boundary",
    )

    const buildProvider = dockerSandbox({
      buildContext: workspace,
      client: docker.client,
      dockerfile: path.join(workspace, "Escaping.Dockerfile"),
      workspace,
    })
    await expect(buildProvider.acquire(rootRequest())).rejects.toThrow(
      "Dockerfile resolves outside its configured boundary",
    )
    expect(docker.createRequests).toHaveLength(0)
  })

  it("states the writable-source requirement before Docker acquisition", async () => {
    const workspace = await createWorkspace()
    const repository = path.join(workspace, "repository")
    const docker = createDockerHarness()
    const provider = dockerSandbox({
      client: docker.client,
      image: "alpine:3.22",
      workspace,
    })

    await chmod(repository, 0o555)

    try {
      await expect(
        provider.acquire(
          rootRequest({
            access: "read-only",
            root: "repository",
          }),
        ),
      ).rejects.toThrow(
        "selected source must be writable for namespace verification",
      )
      expect(docker.createRequests).toHaveLength(0)
    } finally {
      await chmod(repository, 0o755)
    }
  })

  it("waits for a cancelled create to settle before cleanup", async () => {
    const workspace = await createWorkspace()
    const docker = createDockerHarness()
    const controller = new AbortController()
    const cancellation = new Error("cancel Docker create")
    let createStarted: (() => void) | undefined
    let finishCreate: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      createStarted = resolve
    })
    const finish = new Promise<void>((resolve) => {
      finishCreate = resolve
    })

    vi.spyOn(docker.client, "createContainer").mockImplementationOnce(
      async (options) => {
        docker.createRequests.push(options)
        createStarted?.()
        await finish
        return docker.container
      },
    )
    const provider = dockerSandbox({
      client: docker.client,
      image: "alpine:3.22",
      workspace,
    })
    const pending = provider.acquire(
      rootRequest({ signal: controller.signal }),
    )

    await started
    controller.abort(cancellation)
    expect(docker.removeRequests).toHaveLength(0)
    expect(docker.createRequests[0]?.abortSignal).toBeUndefined()
    finishCreate?.()

    await expect(pending).rejects.toBe(cancellation)
    expect(docker.removeRequests).toEqual([{ force: true }])
  })

  it("attributes Engine failures and preserves failed compensation", async () => {
    const workspace = await createWorkspace()
    const docker = createDockerHarness()
    const engineError = Object.assign(
      new Error("daemon unavailable"),
      { statusCode: 500 },
    )
    const cleanupError = new Error("cleanup unavailable")

    vi.spyOn(docker.client, "createContainer").mockRejectedValueOnce(
      engineError,
    )
    vi.spyOn(docker.container, "remove").mockRejectedValueOnce(
      cleanupError,
    )
    const provider = dockerSandbox({
      client: docker.client,
      image: "alpine:3.22",
      workspace,
    })

    const error = await provider.acquire(rootRequest()).catch(
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(2)
    expect((error as AggregateError).errors[0]).toMatchObject({
      cause: engineError,
      message: "Docker Sandbox creation failed",
    })
    expect((error as AggregateError).errors[1]).toMatchObject({
      cause: cleanupError,
    })
  })

  it("reconciles an ambiguous create failure until a late container appears", async () => {
    const workspace = await createWorkspace()
    const docker = createDockerHarness()
    const notFound = { statusCode: 404 }
    let inspections = 0

    vi.spyOn(docker.client, "createContainer").mockRejectedValueOnce(
      new Error("connection reset after request"),
    )
    vi.spyOn(docker.container, "inspect").mockImplementation(
      async () => {
        inspections += 1

        if (inspections < 3) {
          throw notFound
        }

        return {} as Dockerode.ContainerInspectInfo
      },
    )
    const provider = dockerSandbox({
      client: docker.client,
      image: "alpine:3.22",
      workspace,
    })

    await expect(provider.acquire(rootRequest())).rejects.toThrow(
      "Docker Sandbox creation failed",
    )
    expect(inspections).toBe(3)
    expect(docker.removeRequests).toEqual([{ force: true }])
  })

  it("rejects a daemon that resolves a different workspace namespace", async () => {
    const workspace = await createWorkspace()
    const docker = createDockerHarness()

    vi.spyOn(docker.client, "createContainer").mockImplementationOnce(
      async (options) => {
        docker.createRequests.push(options)
        const probe = options.HostConfig?.Mounts?.find(
          (mount) =>
            mount.Target === "/run/aml-host-namespace",
        )

        if (probe === undefined) {
          throw new Error("namespace probe mount was not configured")
        }

        await writeFile(
          path.join(probe.Source, "identity"),
          "daemon sees different content",
        )
        return docker.container
      },
    )
    const provider = dockerSandbox({
      client: docker.client,
      image: "alpine:3.22",
      workspace,
    })

    await expect(provider.acquire(rootRequest())).rejects.toThrow(
      "startup or namespace verification failed",
    )
    expect(docker.removeRequests).toEqual([{ force: true }])
  })

  it("validates provider configuration without performing I/O", () => {
    expect(() =>
      dockerSandbox({
        image: "alpine",
        dockerfile: "./Dockerfile",
        workspace: ".",
      }),
    ).toThrow("requires exactly one of image or dockerfile")
    expect(() =>
      dockerSandbox({
        buildContext: ".",
        image: "alpine",
        workspace: ".",
      }),
    ).toThrow("buildContext requires dockerfile")
    expect(() =>
      dockerSandbox({
        cpus: 0,
        image: "alpine",
        workspace: ".",
      }),
    ).toThrow("Docker cpus must be a positive finite number")
    expect(() =>
      dockerSandbox({
        cpus: Number.MAX_VALUE,
        image: "alpine",
        workspace: ".",
      }),
    ).toThrow("cannot be represented as a positive NanoCPUs integer")
    expect(() =>
      dockerSandbox({
        image: "alpine",
        memoryBytes: 1.5,
        workspace: ".",
      }),
    ).toThrow(
      "Docker memoryBytes must be a positive safe integer",
    )
    expect(() =>
      dockerSandbox({
        image: " alpine ",
        workspace: ".",
      }),
    ).toThrow("Docker image must be a non-empty normalized string")
    for (const user of ["0", "0:0", "root", "1000:0"]) {
      expect(() =>
        dockerSandbox({
          image: "alpine",
          user,
          workspace: ".",
        }),
      ).toThrow("Docker user must be a numeric non-root UID")
    }
    expect(() =>
      dockerSandbox({
        client: new Dockerode({
          host: "127.0.0.1",
          port: 2375,
        }),
        image: "alpine",
        workspace: ".",
      }),
    ).toThrow("requires a same-host local-socket Docker client")
  })

  it("accepts only sessions enforced by the acquired bind mount", async () => {
    const workspace = await createWorkspace()
    const docker = createDockerHarness()
    const provider = dockerSandbox({
      client: docker.client,
      image: "alpine:3.22",
      workspace,
    })
    const acquired = await provider.acquire(
      rootRequest({ root: "repository" }),
    )
    const lease: SandboxLeaseReference<DockerSandboxHandle> = {
      handle: acquired.handle,
      id: acquired.id,
    }
    const base: SandboxSession<DockerSandboxHandle> = {
      access: "read-only",
      cwd: "repository",
      lease,
      nested: false,
      provider: { name: "docker" },
      root: "repository",
    }

    expect(supportsDockerSandbox(base)).toBe(true)
    expect(
      supportsDockerSandbox({ ...base, root: "repository/src" }),
    ).toBe(false)
    expect(
      supportsDockerSandbox({ ...base, access: "read-write" }),
    ).toBe(false)
    expect(
      supportsDockerSandbox({
        ...base,
        provider: { name: "other" },
      }),
    ).toBe(false)

    await acquired.release()
  })

  it("passes the reusable SDK Sandbox conformance lifecycle", async () => {
    const workspace = await createWorkspace()
    const docker = createDockerHarness()
    const provider = dockerSandbox({
      client: docker.client,
      image: "alpine:3.22",
      workspace,
    })

    await expect(
      sandboxProviderConformance(provider),
    ).resolves.toBeUndefined()
  })
})

/**
 * Creates a real Dockerode client whose Engine methods are deterministic.
 */
function createDockerHarness(
  output: {
    readonly exitCode?: number
    readonly stderr?: string
    readonly stdout?: string
  } = {},
): DockerHarness {
  const client = new Dockerode()
  const container = client.getContainer("container-123")
  const execution = client.getExec("exec-123")
  const createRequests: Dockerode.ContainerCreateOptions[] = []
  const execRequests: Dockerode.ExecCreateOptions[] = []
  const removeRequests: Dockerode.ContainerRemoveOptions[] = []
  const startRequests: Dockerode.ContainerStartOptions[] = []

  vi.spyOn(client, "getContainer").mockReturnValue(container)
  vi.spyOn(client, "createContainer").mockImplementation(
    async (options) => {
      createRequests.push(options)
      return container
    },
  )
  vi.spyOn(container, "start").mockImplementation(async (options = {}) => {
    startRequests.push(options)
  })
  vi.spyOn(container, "remove").mockImplementation(
    async (options = {}) => {
      removeRequests.push(options)
    },
  )
  vi.spyOn(container, "exec").mockImplementation(async (options) => {
    execRequests.push(options)
    return execution
  })
  vi.spyOn(execution, "start").mockImplementation(async () => {
    const request = execRequests.at(-1)
    const namespaceProbe = isNamespaceProbeCommand(request)
    const probeMount = createRequests
      .at(-1)
      ?.HostConfig?.Mounts?.find(
        (mount) => mount.Target === "/run/aml-host-namespace",
      )
    const stdout =
      namespaceProbe && probeMount !== undefined
        ? await readFile(
            path.join(probeMount.Source, "identity"),
            "utf8",
          )
        : output.stdout ?? ""
    const stream = new PassThrough()
    stream.end(
      Buffer.concat([
        dockerFrame(1, stdout),
        dockerFrame(
          2,
          namespaceProbe ? "" : output.stderr ?? "",
        ),
      ]),
    )
    return stream
  })
  vi.spyOn(execution, "inspect").mockImplementation(async () => ({
    ExitCode: isNamespaceProbeCommand(execRequests.at(-1))
      ? 0
      : output.exitCode ?? 0,
  }) as Dockerode.ExecInspectInfo)

  return {
    client,
    container,
    createRequests,
    execRequests,
    removeRequests,
    startRequests,
  }
}

/**
 * Recognizes the provider's host-namespace verification command.
 */
function isNamespaceProbeCommand(
  request: Dockerode.ExecCreateOptions | undefined,
): boolean {
  return (
    request?.Cmd?.[0] === "sh" &&
    request.Cmd[1] === "-c" &&
    request.Cmd[2]?.includes(
      "/run/aml-host-namespace/identity",
    ) === true
  )
}

/**
 * Encodes one Docker raw-stream frame for the real Dockerode demultiplexer.
 */
function dockerFrame(
  stream: 1 | 2,
  value: string,
): Buffer {
  const content = Buffer.from(value)
  const header = Buffer.alloc(8)
  header.writeUInt8(stream, 0)
  header.writeUInt32BE(content.byteLength, 4)
  return Buffer.concat([header, content])
}

/**
 * Creates one real host workspace for filesystem-containment tests.
 */
async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "aml-docker-test-"),
  )
  temporaryDirectories.push(workspace)
  await mkdir(path.join(workspace, "repository", "src"), {
    recursive: true,
  })
  await writeFile(
    path.join(workspace, "repository", "src", "source.txt"),
    "fixture",
  )
  await writeFile(
    path.join(workspace, "Dockerfile"),
    "FROM alpine:3.22\n",
  )
  return workspace
}

/**
 * Builds one direct provider request with a live cancellation boundary.
 */
function rootRequest(
  overrides: Partial<SandboxAcquireRequest> = {},
): SandboxAcquireRequest {
  const root = overrides.root ?? "."

  return {
    access: overrides.access ?? "read-only",
    cwd: overrides.cwd ?? root,
    evaluationId: "evaluation-123",
    root,
    signal: new AbortController().signal,
    ...(overrides.evaluationId === undefined
      ? {}
      : { evaluationId: overrides.evaluationId }),
    ...(overrides.signal === undefined
      ? {}
      : { signal: overrides.signal }),
  }
}
