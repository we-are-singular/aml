import {
  AmlNode,
  type AmlComponent,
  type AmlRenderable,
} from "./core/aml-node.js"

interface FragmentProps {
  children?: AmlRenderable
}

/**
 * Groups AML children without adding text or execution behavior.
 */
export function Fragment({ children }: FragmentProps): AmlRenderable {
  return children
}

/**
 * Constructs an AML descriptor for TypeScript's automatic JSX runtime.
 */
export function jsx<Props>(
  type: AmlComponent<Props>,
  props: (Props & { children?: AmlRenderable }) | null,
  _key?: string,
): AmlNode<Props> {
  return new AmlNode(
    type,
    (props ?? {}) as Props & { children?: AmlRenderable },
  )
}

/**
 * Multi-child transform alias required by TypeScript's automatic JSX runtime.
 */
export const jsxs = jsx

/**
 * TypeScript JSX contracts exposed by the AML production transform.
 */
export namespace JSX {
  export type Element = AmlNode
  export type ElementType = AmlComponent<any>

  export interface ElementChildrenAttribute {
    children: unknown
  }

  export interface IntrinsicElements {}
}
