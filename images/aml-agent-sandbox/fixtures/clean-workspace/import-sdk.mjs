import { Fragment } from "@aml-jsx/sdk"

if (typeof Fragment !== "function") {
  throw new TypeError("@aml-jsx/sdk did not expose Fragment")
}

console.log("sdk bare import ok")
