import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"

/**
 * Local and inline instruction content plus optional model-facing labels.
 */
export interface SkillProps {
  /**
   * Inline AML instruction content.
   *
   * When `src` is also present, file content comes first, followed by a newline
   * and the resolved children. At least one of `children` or `src` is required,
   * and their combined content must resolve to non-empty text.
   */
  readonly children?: AmlRenderable

  /**
   * Optional non-empty normalized model-facing description.
   *
   * When supplied, AML prepends it as `Description: …` before the instruction
   * content. Omission adds no description label.
   */
  readonly description?: string

  /**
   * Optional non-empty normalized model-facing Skill name.
   *
   * When supplied, AML prepends it as `Skill: …` before the instruction content.
   * Omission adds no name label.
   */
  readonly name?: string

  /**
   * Local UTF-8 instruction file read at evaluation time.
   *
   * Relative paths resolve from `AmlRuntimeOptions.cwd`, not from an active
   * Workspace or Sandbox. Omission uses inline children only.
   */
  readonly src?: string
}

/**
 * Contributes reusable local or inline instruction text at its authored position.
 *
 * This is ordinary prompt text rather than an installed coding-agent capability.
 * AML reads `src` after child evaluation, does not cache it, and preserves the
 * component's authored placement inside an Agent prompt or `System` block.
 */
export function Skill(_props: SkillProps): never {
  throw new Error("<Skill> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Skill, "skill")
