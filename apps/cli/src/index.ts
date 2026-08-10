#!/usr/bin/env node
import { Cli, Builtins } from "clipanion"
import { argv } from "node:process"

import { RunCommand } from "./commands/run.js"

declare const __CLI_VERSION__: string

const cli = new Cli({
  binaryLabel: "AML CLI",
  binaryName: "aml",
  binaryVersion: `${typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : "dev"}`,
})

cli.register(Builtins.HelpCommand)
cli.register(Builtins.VersionCommand)
cli.register(RunCommand)

await cli.runExit(argv.slice(2))
