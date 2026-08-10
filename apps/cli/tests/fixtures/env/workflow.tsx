import { env } from "node:process"

export default [env.CLI_TEST_SHARED, "|", env.CLI_TEST_MODE, "|", env.CLI_TEST_OVERRIDE]
