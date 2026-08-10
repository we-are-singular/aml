import { access, readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { cwd, env as processEnv } from "node:process"

import { loadEnv } from "vite"

export function parseEnvFile(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {}

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue
    }

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (match === null) {
      continue
    }

    const key = match[1] ?? ""
    if (key === "") {
      continue
    }

    const raw = match[2] ?? ""

    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        parsed[key] = JSON.parse(raw)
      } catch {
        parsed[key] = raw.slice(1, -1)
      }
      continue
    }

    if (raw.startsWith("'") && raw.endsWith("'")) {
      parsed[key] = raw.slice(1, -1).replace(/\\'/g, "'")
      continue
    }

    const unquoted = raw.replace(/\s*#.*$/, "")
    parsed[key] = unquoted
  }

  return parsed
}

export async function applyWorkflowEnv(filePath: string, envFilePath?: string): Promise<void> {
  const environment = processEnv.NODE_ENV ?? "development"
  const workflowEnv = loadEnv(environment, dirname(filePath), "")

  for (const [key, value] of Object.entries(workflowEnv)) {
    if (processEnv[key] === undefined) {
      processEnv[key] = value
    }
  }

  if (envFilePath !== undefined) {
    const envFileFromCwd = resolve(cwd(), envFilePath)
    const envFileFromWorkflow = resolve(dirname(filePath), envFilePath)
    let normalizedEnvFile = envFileFromCwd

    try {
      await access(envFileFromCwd)
    } catch {
      normalizedEnvFile = envFileFromWorkflow
    }

    const raw = await readFile(normalizedEnvFile, "utf8")
    for (const [key, value] of Object.entries(parseEnvFile(raw))) {
      processEnv[key] = value
    }
  }
}
