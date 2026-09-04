import type { AML } from "@aml-jsx/sdk"

/**
 * Demonstrates bottom-up evaluation across ordinary async components.
 */
export default function BasicExample() {
  async function Context() {
    await Promise.resolve()
    return "bottom-up"
  }

  function Section({ children }: AML.PropsWithRequiredChildren): AML {
    return ["AML resolves ", children]
  }

  return (
    <Section>
      <Context />
    </Section>
  )
}
