import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import type { AmlRenderable } from "../../core/aml-node.js"
import { EvaluationError } from "../../core/evaluation-error.js"
import type { SkillProps } from "./skill.js"

/**
 * Immutable Skill inputs captured before any child AML effects begin.
 */
export interface SkillEvaluation {
  readonly children: AmlRenderable
  readonly description: string | undefined
  readonly hasChildren: boolean
  readonly name: string | undefined
  readonly source: string | undefined
}

/**
 * Owns local Skill validation, file access, combination, and prompt formatting.
 */
export class SkillEvaluator {
  readonly #cwd: string

  /**
   * Captures the working directory used by relative local Skill paths.
   */
  constructor(cwd: unknown) {
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new TypeError("cwd must be a non-empty string")
    }

    this.#cwd = resolve(cwd)
  }

  /**
   * Validates and snapshots Skill props before evaluating their children.
   */
  prepare(props: Readonly<SkillProps>): SkillEvaluation {
    // Capture public props once so getters cannot change the completion plan
    // after child Agents or components have performed effects.
    const children = Reflect.get(props, "children") as AmlRenderable
    const description = SkillEvaluator.#metadata(
      Reflect.get(props, "description"),
      "description",
    )
    const name = SkillEvaluator.#metadata(
      Reflect.get(props, "name"),
      "name",
    )
    const source = Reflect.get(props, "src")
    const hasChildren = children !== undefined
    const hasSource = source !== undefined

    if (!hasChildren && !hasSource) {
      throw new EvaluationError(
        "<Skill> requires src, children, or both",
      )
    }

    if (
      hasSource &&
      (typeof source !== "string" || source.length === 0)
    ) {
      throw new EvaluationError(
        "<Skill> src must be a non-empty local path",
      )
    }

    return Object.freeze({
      children,
      description,
      hasChildren,
      name,
      source: hasSource ? source : undefined,
    })
  }

  /**
   * Reads any file after child AML resolves, then produces final prompt text.
   */
  async complete(
    plan: SkillEvaluation,
    childContent: string,
    signal: AbortSignal,
  ): Promise<string> {
    let content = childContent

    // Reading at completion preserves AML's post-order rule. An inline child
    // may intentionally create or update the local Skill before it is consumed.
    if (plan.source !== undefined) {
      const fileContent = await this.#read(plan.source, signal)
      content = plan.hasChildren
        ? `${fileContent}\n${childContent}`
        : fileContent
    }

    if (content.trim().length === 0) {
      throw new EvaluationError(
        "<Skill> must resolve to non-empty text",
      )
    }

    const metadata: string[] = []

    if (plan.name !== undefined) {
      metadata.push(`Skill: ${plan.name}`)
    }

    if (plan.description !== undefined) {
      metadata.push(`Description: ${plan.description}`)
    }

    return metadata.length === 0
      ? content
      : `${metadata.join("\n")}\n\n${content}`
  }

  /**
   * Reads one local file at evaluation time without caching its contents.
   */
  async #read(
    source: string,
    signal: AbortSignal,
  ): Promise<string> {
    const path = resolve(this.#cwd, source)

    try {
      const content = await readFile(path, {
        encoding: "utf8",
        signal,
      })
      signal.throwIfAborted()
      return content
    } catch (cause) {
      // Cancellation is caller-owned control flow rather than a filesystem
      // failure attributed to the Skill.
      signal.throwIfAborted()
      throw new EvaluationError(
        `<Skill> could not read local file "${path}"`,
        { cause },
      )
    }
  }

  /**
   * Captures one optional normalized prompt label.
   */
  static #metadata(
    value: unknown,
    prop: "description" | "name",
  ): string | undefined {
    if (value === undefined) {
      return undefined
    }

    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value !== value.trim()
    ) {
      throw new EvaluationError(
        `<Skill> ${prop} must be a non-empty normalized string`,
      )
    }

    return value
  }
}
