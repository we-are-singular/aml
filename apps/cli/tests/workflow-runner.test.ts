import { describe, expect, it } from "vitest"

import { resolveWorkflowExport } from "../src/workflow-runner.js"

describe("workflow export resolution", () => {
  it("prefers the default export over main", () => {
    const main = () => "main"

    expect(resolveWorkflowExport({ default: "default", main }, undefined, "workflow.ts")).toBe("default")
  })

  it("falls back to a main function", () => {
    const main = () => "main"

    expect(resolveWorkflowExport({ main }, undefined, "workflow.ts")).toBe(main)
  })

  it("selects an explicit named export", () => {
    expect(resolveWorkflowExport({ first: "one", second: "two" }, "second", "workflow.ts")).toBe("two")
  })

  it("reports missing named exports in stable order", () => {
    expect(() => resolveWorkflowExport({ zebra: true, alpha: true }, "missing", "workflow.ts")).toThrow(
      'file "workflow.ts" does not export "missing". Available exports: alpha, zebra'
    )
  })

  it("reports an empty module clearly", () => {
    expect(() => resolveWorkflowExport({}, undefined, "workflow.ts")).toThrow(
      'file "workflow.ts" must export either "default" or "main()". Available exports: none'
    )
  })
})
