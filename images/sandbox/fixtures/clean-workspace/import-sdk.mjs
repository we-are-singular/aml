import { Fragment } from "@aml-jsx/sdk"
import process from "node:process"

if (typeof Fragment !== "function") {
  throw new TypeError("@aml-jsx/sdk did not expose Fragment")
}

process.stdout.write("sdk bare import ok\n")
