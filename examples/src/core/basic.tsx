import type { AML } from "@aml-jsx/sdk"

/**
 * Demonstrates bottom-up evaluation across ordinary async components.
 */
export default function BasicExample(): AML {
  const Context: AML.Component = async () => {
    await Promise.resolve()
    return "bottom-up"
  }

  const Section: AML.Component<AML.PropsWithRequiredChildren> = ({ children }) => {
    return ["AML resolves ", children]
  }

  return (
    <Section>
      <Context />
    </Section>
  )
}
