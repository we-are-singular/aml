const AML_NODE_BRAND = Symbol.for("@aml/sdk/node")
const AML_PRIMITIVE_KIND = Symbol.for("@aml/sdk/primitive-kind")
type AmlPrimitiveKind = "agent" | "system"
export type AmlEmpty = boolean | null | undefined

export type AmlRenderable =
  | AmlEmpty
  | AmlNode<any>
  | PromiseLike<AmlRenderable>
  | readonly AmlRenderable[]
  | number
  | string

export type AmlComponent<Props = Record<string, unknown>> = (
  props: Props,
) => AmlRenderable

export type AmlNodeProps<Props = Record<string, unknown>> = Readonly<
  Props & {
    children?: AmlRenderable
  }
>

/**
 * Immutable JSX descriptor evaluated by AmlRuntime.
 *
 * Construction never invokes a component. Holding invocation until evaluation
 * lets the runtime preserve ordering, depth, and future execution scopes.
 */
export class AmlNode<Props = Record<string, unknown>> {
  declare readonly $$typeof: symbol
  readonly props: AmlNodeProps<Props>
  readonly type: AmlComponent<Props>

  constructor(
    type: AmlComponent<Props>,
    props: Props & { children?: AmlRenderable },
  ) {
    this.type = type
    this.props = Object.freeze({ ...props })
    Object.defineProperty(this, "$$typeof", { value: AML_NODE_BRAND })
    Object.freeze(this)
  }

  static is(value: unknown): value is AmlNode {
    return (
      typeof value === "object" &&
      value !== null &&
      Reflect.get(value, "$$typeof") === AML_NODE_BRAND
    )
  }

  static markPrimitive(
    component: AmlComponent<any>,
    kind: AmlPrimitiveKind,
  ): void {
    Object.defineProperty(component, AML_PRIMITIVE_KIND, {
      value: kind,
    })
  }

  static primitiveKind(
    component: AmlComponent<any>,
  ): AmlPrimitiveKind | undefined {
    const kind = (
      component as AmlComponent<any> & {
        readonly [AML_PRIMITIVE_KIND]?: unknown
      }
    )[AML_PRIMITIVE_KIND]

    return kind === "agent" || kind === "system" ? kind : undefined
  }
}
