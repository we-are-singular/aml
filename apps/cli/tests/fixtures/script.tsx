import process from "node:process"

import { Script } from "@aml-jsx/sdk"

export default (
  <Script
    command={process.execPath}
    args={["-e", "process.stdout.write(process.cwd())"]}
    cwd="apps/cli"
    timeoutMs={10_000}
  />
)
