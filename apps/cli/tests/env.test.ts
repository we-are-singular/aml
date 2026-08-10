import { resolve } from "node:path"
import { env as processEnv } from "node:process"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { applyWorkflowEnv } from "../src/env.js"

const fixtureWorkflowPath = resolve(import.meta.dirname, "fixtures/env/workflow.tsx")
const managedKeys = ["CLI_TEST_HASH", "CLI_TEST_MODE", "CLI_TEST_OVERRIDE", "CLI_TEST_SHARED", "NODE_ENV"] as const
let originalValues: Readonly<Record<string, string | undefined>>

beforeEach(() => {
  originalValues = Object.fromEntries(managedKeys.map(key => [key, processEnv[key]]))
  for (const key of managedKeys) {
    delete processEnv[key]
  }
})

afterEach(() => {
  for (const key of managedKeys) {
    const original = originalValues[key]
    if (original === undefined) {
      delete processEnv[key]
    } else {
      processEnv[key] = original
    }
  }
})

describe("workflow environment", () => {
  it("loads base and mode-specific Vite env files without replacing process values", async () => {
    processEnv.NODE_ENV = "dev"
    processEnv.CLI_TEST_SHARED = "from-process"

    await applyWorkflowEnv(fixtureWorkflowPath)

    expect(processEnv.CLI_TEST_SHARED).toBe("from-process")
    expect(processEnv.CLI_TEST_MODE).toBe("from-dotenv-dev")
    expect(processEnv.CLI_TEST_OVERRIDE).toBe("from-dotenv")
  })

  it("applies the explicit env file last using Node dotenv semantics", async () => {
    processEnv.NODE_ENV = "dev"
    processEnv.CLI_TEST_SHARED = "from-process"

    await applyWorkflowEnv(fixtureWorkflowPath, ".env.custom")

    expect(processEnv.CLI_TEST_SHARED).toBe("from-custom")
    expect(processEnv.CLI_TEST_MODE).toBe("from-dotenv-dev")
    expect(processEnv.CLI_TEST_OVERRIDE).toBe("from-env-file")
    expect(processEnv.CLI_TEST_HASH).toBe("value # preserved")
  })
})
