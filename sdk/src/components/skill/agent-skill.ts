/**
 * One validated Agent Skill package prepared for a provider session.
 *
 * Paths are concrete in the Agent's execution environment. Providers may use
 * them for native discovery; prompt fallback names only `skillFile` and never
 * embeds the Skill body.
 */
export interface AgentSkill {
  /** Human-readable activation guidance from the package frontmatter. */
  readonly description: string

  /** Concrete directory containing the complete staged package. */
  readonly directory: string

  /** Safe Agent Skills package name from the package frontmatter. */
  readonly name: string

  /** Concrete path to the package's staged `SKILL.md`. */
  readonly skillFile: string
}
