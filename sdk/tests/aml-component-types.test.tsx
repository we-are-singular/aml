import { describe, expect, expectTypeOf, it } from "vitest"

import type { AML, AmlRenderable } from "../src/index.js"

describe("AML component authoring types", () => {
  it("supports synchronous and asynchronous leaf components without implicit children", () => {
    const Leaf: AML.Component = () => "leaf"
    const NamedLeaf: AML.Component<{ readonly name: string }> = ({ name }) => name
    const AsyncLeaf: AML.Component<{ readonly name: string }> = async ({ name }) => name

    const leaf = <Leaf />
    const namedLeaf = <NamedLeaf name="named" />
    const asyncLeaf = <AsyncLeaf name="async" />
    const renderable: AML = Promise.resolve([leaf, namedLeaf, asyncLeaf])

    // @ts-expect-error default leaf components do not accept authored children
    const leafWithChildren = <Leaf>child</Leaf>
    // @ts-expect-error default leaf components do not accept custom props
    const leafWithProps = <Leaf name="unexpected" />
    // @ts-expect-error custom props do not imply a children prop
    const namedLeafWithChildren = <NamedLeaf name="named">child</NamedLeaf>

    expectTypeOf<AML>().toEqualTypeOf<AmlRenderable>()
    expect(renderable).toBeInstanceOf(Promise)
    expect([leafWithChildren, leafWithProps, namedLeafWithChildren]).toHaveLength(3)
  })

  it("makes optional and required children explicit", () => {
    type OptionalProps = AML.PropsWithChildren<{ readonly label: string }>
    type RequiredProps = AML.PropsWithRequiredChildren<{ readonly label: string }>

    const Optional: AML.Component<OptionalProps> = ({ children, label }) => [label, children]
    const Required: AML.Component<RequiredProps> = async ({ children, label }) => [label, children]

    const optionalWithoutChildren = <Optional label="optional" />
    const optionalWithChildren = <Optional label="optional">child</Optional>
    const requiredWithChildren = <Required label="required">child</Required>
    const requiredWithEmptyChildren = <Required label="required">{null}</Required>

    // @ts-expect-error required-children props reject a self-closing component
    const requiredWithoutChildren = <Required label="required" />

    expectTypeOf(optionalWithoutChildren).toMatchTypeOf<AML>()
    expectTypeOf(optionalWithChildren).toMatchTypeOf<AML>()
    expectTypeOf(requiredWithChildren).toMatchTypeOf<AML>()
    expectTypeOf(requiredWithEmptyChildren).toMatchTypeOf<AML>()
    expect(requiredWithoutChildren).toBeDefined()
  })
})
