import { describe, expect, it } from "vitest"
import ts from "@typescript/typescript6"

import { Block } from "../src/components/block/block.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { multiline } from "../src/core/multiline.js"

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

  it("leaves the tagged template intact through the development JSX transform", () => {
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
  })

  it("shows that the JSX transform normalizes natural multiline text before Block receives it", () => {
    const transformed = ts.transpileModule(
      `
        const result = (
          <Block multiline>
            Review the change:

            - Check behavior
            - Check tests
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

    expect(transformed).toContain('children: "Review the change: - Check behavior - Check tests"')
  })

  it("preserves deeper indentation", async () => {
    await expect(
      new AmlRuntime().evaluate(multiline`
        - Check behavior
          - Check nested behavior

            const result = true
      `)
    ).resolves.toBe("- Check behavior\n  - Check nested behavior\n\n    const result = true")
  })

  it.each([
    ["empty", multiline``, ""],
    ["whitespace-only", multiline`\n    \n`, ""],
    ["without surrounding blank lines", multiline`first\n  second`, "first\n  second"],
  ])("handles %s content", async (_case, content, expected) => {
    await expect(new AmlRuntime().evaluate(content)).resolves.toBe(expected)
  })

  it("preserves adjacent, leading, and trailing interpolations", async () => {
    const first = <Block>first</Block>
    const second = Promise.resolve("second")

    await expect(new AmlRuntime().evaluate(multiline`${first}${second} third ${"fourth"}`)).resolves.toBe(
      "\n\nfirst\n\nsecond third fourth"
    )
  })

  it("preserves an interpolation on an otherwise empty indented line", async () => {
    await expect(
      new AmlRuntime().evaluate(multiline`
        before
        ${<Block>inside</Block>}
        after
      `)
    ).resolves.toBe("before\n\n\ninside\n\n\nafter")
  })

  it("does not confuse marker-like authored text with interpolation markers", async () => {
    await expect(
      new AmlRuntime().evaluate(multiline`
        \u{e000}aml-multiline-0\u{e001}
        ${"value"}
      `)
    ).resolves.toBe("\u{e000}aml-multiline-0\u{e001}\nvalue")
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

  it("uses the same dedentation for the tag and Block convenience prop", async () => {
    const source = `
      Review the change:

        - Preserve deeper indentation
    `
    const strings = Object.assign([source], { raw: [source] }) as unknown as TemplateStringsArray

    const [tagged, block] = await Promise.all([
      new AmlRuntime().evaluate(<Block>{multiline(strings)}</Block>),
      new AmlRuntime().evaluate(<Block multiline>{source}</Block>),
    ])

    expect(tagged).toBe(block)
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
