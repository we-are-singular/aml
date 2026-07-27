const AML_NODE_BRAND = Symbol.for("@aml/sdk/node")
const AML_PRIMITIVE_KIND = Symbol.for("@aml/sdk/primitive-kind")
type AmlPrimitiveKind =
  | "agent"
  | "sandbox"
  | "skill"
  | "system"
  | "tool"
  | "workspace"

/**
 * JSX values that intentionally contribute no AML output.
 */
export type AmlEmpty = boolean | null | undefined

/**
 * Complete set of values accepted by the asynchronous AML evaluator.
 */
export type AmlRenderable =
  | AmlEmpty
  | AmlNode<any>
  | PromiseLike<AmlRenderable>
  | readonly AmlRenderable[]
  | number
  | string

/**
 * Function-component contract used by the AML JSX runtime.
 */
export type AmlComponent<Props = Record<string, unknown>> = (
  props: Props,
) => AmlRenderable

/**
 * Immutable component props after JSX child normalization.
 */
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

  /**
   * Captures a component reference and immutable props without invoking it.
   */
  constructor(
    type: AmlComponent<Props>,
    props: Props & { children?: AmlRenderable },
  ) {
    this.type = type
    this.props = Object.freeze({ ...props })
    Object.defineProperty(this, "$$typeof", { value: AML_NODE_BRAND })
    Object.freeze(this)
  }

  /**
   * Recognizes AML nodes across physical copies of the SDK package.
   */
  static is(value: unknown): value is AmlNode {
    return (
      typeof value === "object" &&
      value !== null &&
      Reflect.get(value, "$$typeof") === AML_NODE_BRAND
    )
  }

  /**
   * Marks a built-in component for runtime-owned primitive evaluation.
   */
  static markPrimitive(
    component: AmlComponent<any>,
    kind: AmlPrimitiveKind,
  ): void {
    Object.defineProperty(component, AML_PRIMITIVE_KIND, {
      value: kind,
    })
  }

  /**
   * Returns a previously registered primitive kind without invoking the component.
   */
  static primitiveKind(
    component: AmlComponent<any>,
  ): AmlPrimitiveKind | undefined {
    const kind = (
      component as AmlComponent<any> & {
        readonly [AML_PRIMITIVE_KIND]?: unknown
      }
    )[AML_PRIMITIVE_KIND]

    return kind === "agent" ||
      kind === "sandbox" ||
      kind === "skill" ||
      kind === "system" ||
      kind === "tool" ||
      kind === "workspace"
      ? kind
      : undefined
  }
}
