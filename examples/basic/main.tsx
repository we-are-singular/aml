import {
  AmlRuntime,
  Fragment,
  type AmlRenderable,
} from "@aml/sdk"

interface SectionProps {
  children?: AmlRenderable
}

let contextCalls = 0

async function Context() {
  contextCalls += 1
  await Promise.resolve()
  return "bottom-up"
}

function Section({ children }: SectionProps) {
  return ["AML resolves ", children]
}

const runtime = new AmlRuntime()
const output = await runtime.evaluate(
  <>
    <Fragment>
      <Section>
        <Context />
      </Section>
    </Fragment>
    {[" into ", Promise.resolve("one string")]}
  </>,
)

if (output !== "AML resolves bottom-up into one string") {
  throw new Error(`Unexpected AML output: ${output}`)
}

if (contextCalls !== 1) {
  throw new Error(`Context rendered ${contextCalls} times`)
}

console.log(output)
