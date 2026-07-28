// Configured Docker provider and provider-specific options.
export { dockerSandbox, type DockerSandboxOptions } from "./docker-sandbox.js"

// Opaque handle consumed by compatible Agent adapters.
export type { DockerCommandResult, DockerExecOptions, DockerSandboxHandle } from "./docker-sandbox-handle.js"
export { supportsDockerSandbox } from "./supports-docker-sandbox.js"
