import type { AmlRenderable } from "@aml-jsx/sdk"

interface SectionProps {
  readonly children?: AmlRenderable
}

/**
 * Demonstrates bottom-up evaluation across ordinary async components.
 */
export default function BasicExample() {
  async function Context() {
    await Promise.resolve()
    return "bottom-up"
  }

  function Section({ children }: SectionProps) {
    return ["AML resolves ", children]
  }

  return (
    <Section>
      <Context />
    </Section>
  )
}
