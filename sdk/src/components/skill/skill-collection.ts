import { EvaluationError } from "../../core/evaluation-error.js"
import type { AgentSkill } from "./agent-skill.js"

/** Owns one Agent's ordered Skill declarations and duplicate-name checks. */
export class SkillCollection {
  readonly #names = new Set<string>()
  readonly #skills: AgentSkill[] = []

  /** Adds one fully staged package without producing prompt text. */
  add(skill: Readonly<AgentSkill>): void {
    if (this.#names.has(skill.name)) {
      throw new EvaluationError(`Agent declares duplicate Skill "${skill.name}"`)
    }

    this.#names.add(skill.name)
    this.#skills.push(skill)
  }

  /** Returns an immutable snapshot for the provider request. */
  values(): readonly AgentSkill[] {
    return Object.freeze([...this.#skills])
  }
}
