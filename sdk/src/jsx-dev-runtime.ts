import {
  type AmlComponent,
  AmlNode,
  type AmlRenderable,
} from "./core/aml-node.js"
import { Fragment, jsx } from "./jsx-runtime.js"

/**
 * Development variant used by automatic JSX transforms.
 *
 * AML does not currently retain source metadata or keys, but accepting the
 * complete transform signature keeps development and production semantics equal.
 */
export function jsxDEV<Props>(
  type: AmlComponent<Props>,
  props: (Props & { children?: AmlRenderable }) | null,
  _key?: string,
  _isStaticChildren?: boolean,
  _source?: unknown,
  _self?: unknown,
): AmlNode<Props> {
  return jsx(type, props)
}

export { Fragment }

/**
 * TypeScript JSX contracts exposed by the AML development transform.
 */
export namespace JSX {
  export type Element = AmlNode
  export type ElementType = AmlComponent<any>

  export interface ElementChildrenAttribute {
    children: unknown
  }

  export interface IntrinsicElements {}
}
