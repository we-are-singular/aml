import { randomUUID } from "node:crypto"
import path from "node:path"

import Dockerode from "dockerode"

const DEFAULT_CPUS = 1
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024
const DEFAULT_PIDS_LIMIT = 128
const DEFAULT_TMPFS_BYTES = 64 * 1024 * 1024

/**
 * Docker-specific resources and limits captured by `dockerSandbox()`.
 */
export interface DockerSandboxOptions {
  readonly buildContext?: string

  /**
   * Same-host Dockerode client used for dependency injection.
   *
   * Bind mounts use paths validated on the AML host, so this provider accepts
   * only local socket transports whose daemon shares that host filesystem.
   */
  readonly client?: Dockerode

  readonly cpus?: number
  readonly dockerfile?: string
  readonly image?: string
  readonly maxOutputBytes?: number
  readonly memoryBytes?: number
  readonly pidsLimit?: number
  readonly tmpfsBytes?: number

  /**
   * Numeric non-root UID, optionally followed by a numeric non-root GID.
   */
  readonly user?: string

  /**
   * Standalone host-directory fallback when no Workspace is active.
   */
  readonly workspace?: string
}

/**
 * Complete immutable configuration consumed by the Docker provider.
 */
export interface ParsedDockerSandboxOptions {
  readonly buildContext?: string
  readonly buildTag: string
  readonly client: Dockerode
  readonly dockerfile?: string
  readonly image?: string
  readonly maxOutputBytes: number
  readonly memoryBytes: number
  readonly nanoCpus: number
  readonly pidsLimit: number
  readonly tmpfsBytes: number
  readonly user: string
  readonly workspace?: string
}

/**
 * Validates provider factory options without starting Docker or reading disk.
 */
export function parseDockerSandboxOptions(
  value: DockerSandboxOptions,
): Readonly<ParsedDockerSandboxOptions> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Docker Sandbox options must be an object")
  }

  const hasDockerfile = value.dockerfile !== undefined
  const hasImage = value.image !== undefined

  if (hasDockerfile === hasImage) {
    throw new TypeError(
      "Docker Sandbox requires exactly one of image or dockerfile",
    )
  }

  if (hasImage && value.buildContext !== undefined) {
    throw new TypeError(
      "Docker Sandbox buildContext requires dockerfile",
    )
  }

  const dockerfile =
    value.dockerfile === undefined
      ? undefined
      : path.resolve(
          requireNormalizedString(
            value.dockerfile,
            "Dockerfile path",
          ),
        )
  const buildContext =
    dockerfile === undefined
      ? undefined
      : path.resolve(
          value.buildContext === undefined
            ? path.dirname(dockerfile)
            : requireNormalizedString(
                value.buildContext,
                "Docker build context",
              ),
        )
  const cpus = requirePositiveNumber(
    value.cpus ?? DEFAULT_CPUS,
    "Docker cpus",
  )
  const client = value.client ?? new Dockerode()

  assertSameHostDockerClient(client)

  return Object.freeze({
    ...(buildContext === undefined ? {} : { buildContext }),
    buildTag: `aml-sandbox-${randomUUID()}:latest`,
    client,
    ...(dockerfile === undefined ? {} : { dockerfile }),
    ...(value.image === undefined
      ? {}
      : {
          image: requireNormalizedString(
            value.image,
            "Docker image",
          ),
        }),
    maxOutputBytes: requirePositiveInteger(
      value.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "Docker maxOutputBytes",
    ),
    memoryBytes: requirePositiveInteger(
      value.memoryBytes ?? DEFAULT_MEMORY_BYTES,
      "Docker memoryBytes",
    ),
    nanoCpus: toNanoCpus(cpus),
    pidsLimit: requirePositiveInteger(
      value.pidsLimit ?? DEFAULT_PIDS_LIMIT,
      "Docker pidsLimit",
    ),
    tmpfsBytes: requirePositiveInteger(
      value.tmpfsBytes ?? DEFAULT_TMPFS_BYTES,
      "Docker tmpfsBytes",
    ),
    user: requireNonRootUser(
      value.user ?? defaultDockerUser(),
    ),
    ...(value.workspace === undefined
      ? {}
      : {
          workspace: path.resolve(
            requireNormalizedString(
              value.workspace,
              "Docker workspace",
            ),
          ),
        }),
  })
}

/**
 * Rejects network clients because bind paths belong to the daemon host.
 */
function assertSameHostDockerClient(client: Dockerode): void {
  if (
    typeof client !== "object" ||
    client === null ||
    typeof client.createContainer !== "function" ||
    typeof client.getContainer !== "function" ||
    typeof client.buildImage !== "function" ||
    typeof client.modem !== "object" ||
    client.modem === null
  ) {
    throw new TypeError(
      "Docker client must be a Dockerode instance",
    )
  }

  // Dockerode exposes transport selection through its modem. A configured
  // host means TCP/HTTP and cannot prove the daemon shares AML's filesystem.
  const host = (
    client as Dockerode & {
      readonly modem: Dockerode["modem"] & {
        readonly host?: unknown
      }
    }
  ).modem.host

  if (host !== undefined) {
    throw new TypeError(
      "Docker Sandbox requires a same-host local-socket Docker client",
    )
  }
}

/**
 * Uses the invoking non-root uid/gid for writable bind-mount compatibility.
 */
function defaultDockerUser(): string {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    const group =
      typeof process.getgid === "function" && process.getgid() !== 0
        ? process.getgid()
        : process.getuid()
    return `${process.getuid()}:${group}`
  }

  return "65532:65532"
}

/**
 * Keeps the public override inside Docker's enforceable non-root identity form.
 */
function requireNonRootUser(value: unknown): string {
  const user = requireNormalizedString(value, "Docker user")

  if (!/^[1-9]\d*(?::[1-9]\d*)?$/.test(user)) {
    throw new TypeError(
      "Docker user must be a numeric non-root UID with an optional non-root GID",
    )
  }

  return user
}

/**
 * Rejects invalid positive integer resource limits.
 */
function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }

  return value
}

/**
 * Rejects invalid positive numeric resource limits.
 */
function requirePositiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`)
  }

  return value
}

/**
 * Converts CPUs to Docker's integer NanoCPUs field without losing precision.
 */
function toNanoCpus(value: number): number {
  const nanoCpus = Math.round(value * 1_000_000_000)

  if (!Number.isSafeInteger(nanoCpus) || nanoCpus <= 0) {
    throw new RangeError(
      "Docker cpus cannot be represented as a positive NanoCPUs integer",
    )
  }

  return nanoCpus
}

/**
 * Rejects strings that change identity across path and Engine boundaries.
 */
function requireNormalizedString(
  value: unknown,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    throw new TypeError(
      `${label} must be a non-empty normalized string`,
    )
  }

  return value
}
