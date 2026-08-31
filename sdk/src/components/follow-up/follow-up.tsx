import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"

/**
 * Authored content for one later input in its containing Agent session.
 */
export interface FollowUpProps {
  /**
   * Content for one later user turn in the containing Agent session.
   *
   * AML resolves and trims the content before the session opens. It must become
   * non-empty text; omission therefore fails evaluation rather than creating an
   * empty turn.
   */
  readonly children?: AmlRenderable
}

/**
 * Stages one static later input in the nearest containing Agent session.
 *
 * AmlRuntime resolves the complete descriptor before the provider session
 * starts; this component never opens or resumes a session itself. Follow-ups
 * retain authored order, share the Agent's provider, history, and capabilities,
 * and count toward the runtime's per-Agent turn limit.
 */
export function FollowUp(_props: FollowUpProps): never {
  throw new Error("<FollowUp> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(FollowUp, "follow-up")
