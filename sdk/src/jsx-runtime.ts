import { AmlNode, type AmlComponent, type AmlRenderable } from "./core/aml-node.js"

/** Props accepted by the JSX Fragment implementation. */
interface FragmentProps {
  /** Renderable values grouped without adding an AML execution boundary. */
  children?: AmlRenderable
}

/**
 * Groups AML children without adding text or execution behavior.
 *
 * A Fragment preserves the authored child order and returns `undefined` when
 * no children are provided.
 */
export function Fragment({ children }: FragmentProps): AmlRenderable {
  return children
}

/**
 * Constructs an AML descriptor for TypeScript's automatic JSX runtime.
 *
 * Components are not invoked during construction. The optional JSX key is
 * accepted for transform compatibility but AML does not retain or interpret it.
 *
 * @param type Function component to invoke during evaluation.
 * @param props Component props captured by the node; `null` becomes an empty object.
 * @param _key JSX transform key, currently ignored by AML.
 */
export function jsx<Props>(
  type: AmlComponent<Props>,
  props:
    | (Props & {
        /** Authored nested JSX content supplied to the component. */
        children?: AmlRenderable
      })
    | null,
  _key?: string
): AmlNode<Props> {
  return new AmlNode(type, (props ?? {}) as Props & { children?: AmlRenderable })
}

/**
 * Multi-child transform alias required by TypeScript's automatic JSX runtime.
 *
 * It has exactly the same behavior as {@link jsx}; the compiler selects the
 * alias based on the authored child shape.
 */
export const jsxs = jsx

/**
 * TypeScript JSX contracts exposed by the AML production transform.
 */
export namespace JSX {
  /** Value produced by an AML JSX expression. */
  export type Element = AmlNode

  /** Function components accepted in AML JSX tag position. */
  export type ElementType = AmlComponent<any>

  /** Compiler hook that maps nested JSX content to the `children` prop. */
  export interface ElementChildrenAttribute {
    /** Property name used by the JSX transform for authored children. */
    children: unknown
  }

  /**
   * AML has no string-named intrinsic elements; every JSX tag is a component.
   */
  export interface IntrinsicElements {}
}
