import { describe, expect, it } from "vitest"
import ts from "@typescript/typescript6"

import { Block } from "../src/components/block/block.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { multiline } from "../src/core/multiline.js"
import { jsxDEV } from "../src/jsx-dev-runtime.js"

describe("multiline", () => {
  it("preserves headings, paragraphs, and unordered and ordered lists", async () => {
    await expect(
      new AmlRuntime().evaluate(
        <Block>
          {multiline`
            # Review

            Review the change:

            - Check behavior
            - Check tests
            - Check documentation

            1. Record findings
            2. Summarize the result
          `}
        </Block>
      )
    ).resolves.toBe(
      "\n\n# Review\n\nReview the change:\n\n- Check behavior\n- Check tests\n- Check documentation\n\n1. Record findings\n2. Summarize the result\n\n"
    )
  })

  it("keeps nested AML expressions in their authored positions", async () => {
    const priority = "correctness"

    await expect(
      new AmlRuntime().evaluate(
        <Block tag="Review Plan">
          {multiline`
            ## Priority

            Check ${priority} first.

            ${<Block tag="Evidence">Capture exact file and line references.</Block>}
          `}
        </Block>
      )
    ).resolves.toBe(
      "\n\n<review-plan>\n## Priority\n\nCheck correctness first.\n\n\n\n<evidence>\nCapture exact file and line references.\n</evidence>\n\n\n</review-plan>\n\n"
    )
  })

  it("survives the development JSX transform", async () => {
    const transformed = ts.transpileModule(
      `
        const result = (
          <Block>
            {multiline\`
              Review the change:

              - Check behavior
              - Check tests
            \`}
          </Block>
        )
      `,
      {
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSXDev,
          jsxImportSource: "@aml-jsx/sdk",
          target: ts.ScriptTarget.ESNext,
        },
      }
    ).outputText

    expect(transformed).toContain('from "@aml-jsx/sdk/jsx-dev-runtime"')
    expect(transformed).toContain("children: multiline `\n              Review the change:")

    const content = multiline`
      Review the change:

      - Check behavior
      - Check tests
    `
    const developmentBlock = jsxDEV(Block, { children: content }, undefined, false, undefined, undefined)

    await expect(new AmlRuntime().evaluate(developmentBlock)).resolves.toBe(
      "\n\nReview the change:\n\n- Check behavior\n- Check tests\n\n"
    )
  })

  it("dedents a direct string child through Block's convenience prop", async () => {
    await expect(
      new AmlRuntime().evaluate(
        <Block multiline>{`
          Review the change:

          - Check behavior
          - Check tests
        `}</Block>
      )
    ).resolves.toBe("\n\nReview the change:\n\n- Check behavior\n- Check tests\n\n")
  })

  it("leaves non-string Block children unchanged in multiline mode", async () => {
    await expect(
      new AmlRuntime().evaluate(
        <Block multiline>
          before<Block>nested</Block>after
        </Block>
      )
    ).resolves.toBe("\n\nbefore\n\nnested\n\nafter\n\n")
  })

  it("does not change ordinary JSX sibling concatenation", async () => {
    await expect(
      new AmlRuntime().evaluate(
        <>
          first <Block>second</Block> third
        </>
      )
    ).resolves.toBe("first \n\nsecond\n\n third")
  })
})
