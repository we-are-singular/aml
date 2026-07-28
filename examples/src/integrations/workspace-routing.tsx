import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

import { Agent, codexAgent, evaluate, localWorkspace, System, Workspace } from "@aml-jsx/sdk"
import { z } from "zod"

const examplesDirectory = resolve(import.meta.dirname, "../..")
const WorkspaceSelection = z.object({
  directory: z.string(),
  task: z.string(),
  workspaceId: z.string(),
})

/**
 * Gives each Codex session an explicit local working directory.
 */
function createExampleProvider(workingDirectory: string) {
  return codexAgent({
    ...(process.env.AML_CODEX_MODEL === undefined ? {} : { model: process.env.AML_CODEX_MODEL }),
    skipGitRepoCheck: true,
    workingDirectory,
  })
}

const DiscoveryProvider = createExampleProvider(examplesDirectory)

/**
 * Uses typed Agent output to choose the resource boundary for later work.
 */
async function WorkspaceRouting() {
  const selection = await evaluate(
    <Agent provider={DiscoveryProvider}>
      <System>
        Select an existing directory inside this workspace root:
        {examplesDirectory}
        Return its absolute path, a short stable workspace ID, and a complete task for the next Agent.
      </System>
      Find the directory containing the core AML examples. Ask the next Agent to summarize what those examples
      demonstrate.
    </Agent>,
    WorkspaceSelection
  )

  const canonicalRoot = await realpath(examplesDirectory)
  const workspaceDirectory = await realpath(resolve(examplesDirectory, selection.directory))
  const relativeDirectory = relative(canonicalRoot, workspaceDirectory)

  // Canonical paths prevent a model-selected symlink from widening the root.
  if (relativeDirectory === ".." || relativeDirectory.startsWith(`..${sep}`) || isAbsolute(relativeDirectory)) {
    throw new TypeError("Discovered Workspace must remain inside the examples directory")
  }

  const Project = localWorkspace({
    directory: workspaceDirectory,
  })
  const ProjectProvider = createExampleProvider(workspaceDirectory)

  return (
    <Workspace id={selection.workspaceId} provider={Project}>
      <Agent provider={ProjectProvider}>{selection.task}</Agent>
    </Workspace>
  )
}

/**
 * Demonstrates structured discovery selecting a later Agent's Workspace.
 */
export default function WorkspaceRoutingExample() {
  return <WorkspaceRouting />
}
