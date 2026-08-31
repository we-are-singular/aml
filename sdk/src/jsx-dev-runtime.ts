import type { AmlNode } from "./core/aml-node.js"
import { type AmlComponent, type AmlRenderable } from "./core/aml-node.js"
import { Fragment, jsx } from "./jsx-runtime.js"

/**
 * Development variant used by automatic JSX transforms.
 *
 * AML does not currently retain source metadata or keys, but accepting the
 * complete transform signature keeps development and production semantics equal.
 * Components are captured as immutable nodes and are invoked only by evaluation.
 *
 * @param type Function component to invoke during evaluation.
 * @param props Component props captured by the node; `null` becomes an empty object.
 * @param _key JSX transform key, currently ignored by AML.
 * @param _isStaticChildren Development-transform child stability hint, currently ignored.
 * @param _source Development source location, currently ignored.
 * @param _self Development owner value, currently ignored.
 */
export function jsxDEV<Props>(
  type: AmlComponent<Props>,
  props:
    | (Props & {
        /** Authored nested JSX content supplied to the component. */
        children?: AmlRenderable
      })
    | null,
  _key?: string,
  _isStaticChildren?: boolean,
  _source?: unknown,
  _self?: unknown
): AmlNode<Props> {
  return jsx(type, props)
}

export { Fragment }

/**
 * TypeScript JSX contracts exposed by the AML development transform.
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
