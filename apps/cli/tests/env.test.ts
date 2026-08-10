import { resolve } from "node:path"
import { env as processEnv } from "node:process"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { applyWorkflowEnv } from "../src/env.js"

const fixtureWorkflowPath = resolve(import.meta.dirname, "env/fixtures/workflow.tsx")

let originalProcessEnv: Record<string, string> = {}

beforeEach(() => {
  originalProcessEnv = Object.fromEntries(
    Object.entries(processEnv).filter(([, value]) => value !== undefined)
  ) as Record<string, string>
  delete processEnv.CLI_TEST_SHARED
  delete processEnv.CLI_TEST_MODE
  delete processEnv.CLI_TEST_OVERRIDE
  delete processEnv.NODE_ENV
})

afterEach(() => {
  for (const key of Object.keys(processEnv)) {
    delete processEnv[key]
  }

  for (const [key, value] of Object.entries(originalProcessEnv)) {
    processEnv[key] = value
  }
})

describe("CLI env loading", () => {
  it("loads .env and .env.${NODE_ENV} when NODE_ENV is dev", async () => {
    processEnv.NODE_ENV = "dev"

    await applyWorkflowEnv(fixtureWorkflowPath)

    expect(processEnv.CLI_TEST_SHARED).toBe("from-dotenv")
    expect(processEnv.CLI_TEST_MODE).toBe("from-dotenv-dev")
    expect(processEnv.CLI_TEST_OVERRIDE).toBe("from-dotenv")
  })

  it("applies --runtime-env-file after Vite env loading for explicit overrides", async () => {
    processEnv.NODE_ENV = "dev"

    await applyWorkflowEnv(fixtureWorkflowPath, ".env.custom")

    expect(processEnv.CLI_TEST_SHARED).toBe("from-custom")
    expect(processEnv.CLI_TEST_MODE).toBe("from-dotenv-dev")
    expect(processEnv.CLI_TEST_OVERRIDE).toBe("from-env-file")
  })
})
