import { describe, expect, it } from "vitest"

import { Agent } from "../src/components/agent/agent.js"
import { Block } from "../src/components/block/block.js"
import { System } from "../src/components/system/system.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { DeterministicAgentProvider } from "../src/testing/deterministic-agent-provider.js"

describe("<Block>", () => {
  it("adds exact blank-line separation around content", async () => {
    await expect(
      new AmlRuntime().evaluate(
        <>
          before<Block>middle</Block>after
        </>
      )
    ).resolves.toBe("before\n\nmiddle\n\nafter")
  })

  it("uses an empty Block as one separator", async () => {
    await expect(
      new AmlRuntime().evaluate(
        <>
          before
          <Block />
          after
        </>
      )
    ).resolves.toBe("before\n\nafter")

    await expect(
      new AmlRuntime().evaluate(
        <>
          before
          <Block tag="unused" />
          after
        </>
      )
    ).resolves.toBe("before\n\nafter")
  })

  it.each([
    ["false", false],
    ["true", true],
    ["null", null],
    ["undefined", undefined],
  ] as const)("treats a direct %s child as an empty Block", async (_label, child) => {
    await expect(
      new AmlRuntime().evaluate(
        <>
          before<Block>{child}</Block>after
        </>
      )
    ).resolves.toBe("before\n\nafter")
  })

  it("preserves zero as Block content", async () => {
    await expect(
      new AmlRuntime().evaluate(
        <>
          before<Block>{0}</Block>after
        </>
      )
    ).resolves.toBe("before\n\n0\n\nafter")
  })

  it("wraps content in a kebab-cased section tag", async () => {
    await expect(
      new AmlRuntime().evaluate(
        <>
          before<Block tag="Personal Data">middle</Block>after
        </>
      )
    ).resolves.toBe("before\n\n<personal-data>\nmiddle\n</personal-data>\n\nafter")
  })

  it("neutralizes tag syntax in section names", async () => {
    await expect(new AmlRuntime().evaluate(<Block tag="Review <Data/Raw">middle</Block>)).resolves.toBe(
      "\n\n<review-data-raw>\nmiddle\n</review-data-raw>\n\n"
    )
  })

  it("keeps the Block untagged when normalization removes the whole name", async () => {
    await expect(new AmlRuntime().evaluate(<Block tag="<///">middle</Block>)).resolves.toBe("\n\nmiddle\n\n")
  })

  it("remains transparent to Agent ownership", async () => {
    const provider = new DeterministicAgentProvider({
      respond(request) {
        expect(request.prompt).toBe("first\n\n<review-context>\nsecond\n</review-context>\n\nthird")
        expect(request.system).toBe("Block descriptors retain their Agent owner.")
        return { text: "done" }
      },
    })

    await expect(
      new AmlRuntime().evaluate(
        <Agent provider={provider}>
          first
          <Block tag="Review Context">
            <System>Block descriptors retain their Agent owner.</System>
            second
          </Block>
          third
        </Agent>
      )
    ).resolves.toBe("done")
  })
})
