import { access, readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { cwd, env as processEnv } from "node:process"
import { parseEnv } from "node:util"

import { loadEnv } from "vite"

async function resolveEnvFile(filePath: string, workflowDirectory: string): Promise<string> {
  const fromCwd = resolve(cwd(), filePath)

  try {
    await access(fromCwd)
    return fromCwd
  } catch {
    return resolve(workflowDirectory, filePath)
  }
}

/** Applies workflow-local Vite env files, then an optional explicit override file. */
export async function applyWorkflowEnv(filePath: string, envFilePath?: string): Promise<void> {
  const workflowDirectory = dirname(filePath)
  const environment = processEnv.NODE_ENV ?? "development"
  const workflowEnv = loadEnv(environment, workflowDirectory, "")

  for (const [key, value] of Object.entries(workflowEnv)) {
    processEnv[key] ??= value
  }

  if (envFilePath === undefined) {
    return
  }

  const resolvedEnvFile = await resolveEnvFile(envFilePath, workflowDirectory)
  const overrideEnv = parseEnv(await readFile(resolvedEnvFile, "utf8"))

  for (const [key, value] of Object.entries(overrideEnv)) {
    processEnv[key] = value
  }
}
