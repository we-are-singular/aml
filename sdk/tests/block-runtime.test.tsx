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
  })

  it("remains transparent to Agent ownership", async () => {
    const provider = new DeterministicAgentProvider({
      respond(request) {
        expect(request.prompt).toBe("first\n\nsecond\n\nthird")
        expect(request.system).toBe("Block descriptors retain their Agent owner.")
        return { text: "done" }
      },
    })

    await expect(
      new AmlRuntime().evaluate(
        <Agent provider={provider}>
          first
          <Block>
            <System>Block descriptors retain their Agent owner.</System>
            second
          </Block>
          third
        </Agent>
      )
    ).resolves.toBe("done")
  })
})
