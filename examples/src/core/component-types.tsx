import type { AML } from "@aml-jsx/sdk"

/** A leaf contributes text without accepting authored children. */
const Heading: AML.Component = () => "Evidence: "

/** Optional children allow a useful self-closing form. */
const Note: AML.Component<AML.PropsWithChildren<{ fallback: string }>> = ({ children, fallback }) =>
  children ?? fallback

/** Required children describe a composition boundary, even when their value is empty. */
const Section: AML.Component<AML.PropsWithRequiredChildren> = ({ children }) => children

/** Async components use the same contract and run when their node is evaluated. */
const Evidence: AML.Component<{ readonly load: () => Promise<string> }> = async ({ load }) => await load()

/** Demonstrates leaf, async, optional-child, and required-child component contracts. */
export default function ComponentTypesExample(): AML {
  return (
    <Section>
      <Heading />
      <Note fallback="No findings." />{" "}
      <Note fallback="No findings.">
        <Evidence load={async () => "Inspect the changed files."} />
      </Note>
      <Section>{null}</Section>
    </Section>
  )
}
