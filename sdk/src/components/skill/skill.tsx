import { AmlNode } from "../../core/aml-node.js"

/** A complete local Agent Skills package selected for one Agent session. */
export interface SkillProps {
  /**
   * Local package directory containing `SKILL.md` and any supporting files.
   *
   * Relative paths resolve from `AmlRuntimeOptions.cwd`. AML reads and validates
   * the complete package at evaluation time; remote URLs are not supported.
   */
  readonly src: string
}

/**
 * Stages and registers one local Agent Skill package for the containing Agent.
 *
 * The package is available for progressive disclosure through native provider
 * discovery or metadata-only fallback. Its instruction body is never inserted
 * into the prompt automatically.
 */
export function Skill(_props: SkillProps): never {
  throw new Error("<Skill> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Skill, "skill")
