import {
  AmlNode,
  type AmlRenderable,
} from "../../core/aml-node.js"

/**
 * Authored content for one later input in its containing Agent session.
 */
export interface FollowUpProps {
  readonly children?: AmlRenderable
}

/**
 * Stages one static later input in the nearest containing Agent session.
 *
 * AmlRuntime resolves the complete descriptor before the provider session
 * starts; this component never opens or resumes a session itself.
 */
export function FollowUp(_props: FollowUpProps): never {
  throw new Error("<FollowUp> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(FollowUp, "follow-up")
