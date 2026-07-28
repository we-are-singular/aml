import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"

/**
 * Local and inline instruction content plus optional model-facing labels.
 */
export interface SkillProps {
  readonly children?: AmlRenderable
  readonly description?: string
  readonly name?: string
  readonly src?: string
}

/**
 * Contributes resolved instruction text at its authored position.
 */
export function Skill(_props: SkillProps): never {
  throw new Error("<Skill> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Skill, "skill")
