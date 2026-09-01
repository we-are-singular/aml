const AML_NODE_BRAND = Symbol.for("@aml-jsx/sdk/node")
const AML_PRIMITIVE_KIND = Symbol.for("@aml-jsx/sdk/primitive-kind")

/** Runtime-owned discriminator assigned to each built-in AML primitive. */
type AmlPrimitiveKind =
  | "agent"
  | "context"
  | "file"
  | "follow-up"
  | "include"
  | "loop"
  | "mcp"
  | "sandbox"
  | "script"
  | "skill"
  | "system"
  | "tool"
  | "workspace"

/**
 * JSX values that intentionally contribute no AML output.
 *
 * As in UI-oriented JSX runtimes, booleans are treated as empty markers rather
 * than rendered as the strings `"true"` or `"false"`.
 */
export type AmlEmpty = boolean | null | undefined

/**
 * Complete recursive set of values accepted by the asynchronous AML evaluator.
 *
 * Strings are preserved, numbers are stringified, arrays are evaluated in
 * authored order, promises are awaited, and {@link AmlEmpty} values disappear.
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
 *
 * A component may return any renderable value directly or through a Promise.
 * Components run once when their node is evaluated; AML does not rerender them.
 */
export type AmlComponent<Props = Record<string, unknown>> = (props: Props) => AmlRenderable

/**
 * Immutable component props after JSX child normalization.
 *
 * `children` is optional because self-closing components receive no child
 * value. Multiple authored children arrive as an immutable-compatible array.
 */
export type AmlNodeProps<Props = Record<string, unknown>> = Readonly<
  Props & {
    /** Authored nested JSX content after automatic-runtime normalization. */
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
  /** Cross-package brand used by {@link AmlNode.is}; not application metadata. */
  declare readonly $$typeof: symbol

  /** Frozen snapshot of the JSX props captured when this node was constructed. */
  readonly props: AmlNodeProps<Props>

  /** Function component to invoke when the runtime reaches this node. */
  readonly type: AmlComponent<Props>

  /**
   * Captures a component reference and immutable props without invoking it.
   *
   * JSX authors normally receive nodes from the automatic JSX runtime rather
   * than constructing this class directly.
   */
  constructor(
    type: AmlComponent<Props>,
    props: Props & {
      /** Authored nested JSX content after automatic-runtime normalization. */
      children?: AmlRenderable
    }
  ) {
    this.type = type
    this.props = Object.freeze({ ...props })
    Object.defineProperty(this, "$$typeof", { value: AML_NODE_BRAND })
    Object.freeze(this)
  }

  /**
   * Recognizes AML nodes across physical copies of the SDK package.
   *
   * Returns `false` for lookalike objects that do not carry AML's global brand.
   */
  static is(value: unknown): value is AmlNode {
    return typeof value === "object" && value !== null && Reflect.get(value, "$$typeof") === AML_NODE_BRAND
  }

  /**
   * Marks a built-in component for runtime-owned primitive evaluation.
   *
   * This is an SDK implementation hook, not a supported way for applications
   * to define new primitive kinds.
   */
  static markPrimitive(component: AmlComponent<any>, kind: AmlPrimitiveKind): void {
    Object.defineProperty(component, AML_PRIMITIVE_KIND, {
      value: kind,
    })
  }

  /**
   * Returns a previously registered primitive kind without invoking the component.
   *
   * Returns `undefined` for ordinary application components.
   */
  static primitiveKind(component: AmlComponent<any>): AmlPrimitiveKind | undefined {
    const kind = (
      component as AmlComponent<any> & {
        readonly [AML_PRIMITIVE_KIND]?: unknown
      }
    )[AML_PRIMITIVE_KIND]

    return kind === "agent" ||
      kind === "context" ||
      kind === "file" ||
      kind === "follow-up" ||
      kind === "include" ||
      kind === "loop" ||
      kind === "mcp" ||
      kind === "sandbox" ||
      kind === "script" ||
      kind === "skill" ||
      kind === "system" ||
      kind === "tool" ||
      kind === "workspace"
      ? kind
      : undefined
  }
}
