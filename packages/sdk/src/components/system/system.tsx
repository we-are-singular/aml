import {
  AmlNode,
  type AmlRenderable,
} from "../../core/aml-node.js"

export interface SystemProps {
  readonly children?: AmlRenderable
}

/**
 * Routes resolved child text into the nearest Agent system prompt.
 */
export function System(_props: SystemProps): never {
  throw new Error("<System> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(System, "system")
