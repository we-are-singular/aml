import type { AmlModelSchema } from "../agent/aml-model-schema.js"
import type { AgentProps } from "../agent/agent.js"
import { ContextRegistry } from "../context/context-registry.js"
import { ContextScope } from "../context/context-scope.js"
import {
  AmlNode,
  type AmlRenderable,
} from "../../core/aml-node.js"
import { ComponentEvaluationContext } from "../../core/component-evaluation-context.js"
import { EvaluationError } from "../../core/evaluation-error.js"

interface ResolveFrame {
  readonly contextScope: ContextScope
  readonly depth: number
  readonly kind: "resolve"
  readonly value: AmlRenderable
}

interface ArrayFrame {
  readonly contextScope: ContextScope
  readonly depth: number
  readonly index: number
  readonly kind: "array"
  readonly value: readonly AmlRenderable[]
}

interface ReleaseFrame {
  readonly kind: "release"
  readonly value: object
}

type SelectionFrame = ArrayFrame | ReleaseFrame | ResolveFrame

/**
 * One outer Agent selected from a Loop render result before its children run.
 */
interface LoopAgentSelection {
  readonly activeAncestors: ReadonlySet<object>
  readonly agent: AmlNode<AgentProps>
  readonly contextScope: ContextScope
  readonly parentDepth: number
}

/**
 * Resolves only transparent wrappers around a Loop iteration's outer Agent.
 *
 * Agent children remain inert during selection. This lets the runtime reject
 * multiple outer Agents before any of their provider-backed descendants run.
 */
export class LoopAgentSelector {
  readonly #maxDepth: number

  /**
   * Captures the runtime depth policy used by wrapper components.
   */
  constructor(maxDepth: number) {
    this.#maxDepth = maxDepth
  }

  /**
   * Unwraps transparent Context and component shapes to one outer Agent.
   */
  async select(
    value: AmlRenderable,
    initialDepth: number,
    activeAncestors: ReadonlySet<object>,
    initialContextScope: ContextScope,
    signal: AbortSignal,
    evaluateNested: (
      value: AmlRenderable,
      schema: AmlModelSchema<unknown, unknown> | undefined,
      depth: number,
      activeAncestors: ReadonlySet<object>,
      contextScope: ContextScope,
    ) => Promise<unknown>,
  ): Promise<LoopAgentSelection> {
    const activeValues = new Set(activeAncestors)
    const frames: SelectionFrame[] = [
      {
        contextScope: initialContextScope,
        depth: initialDepth,
        kind: "resolve",
        value,
      },
    ]
    let selection: LoopAgentSelection | undefined

    while (frames.length > 0) {
      signal.throwIfAborted()
      const frame = frames.pop()

      if (!frame) {
        break
      }

      if (frame.kind === "release") {
        activeValues.delete(frame.value)
        continue
      }

      if (frame.kind === "array") {
        if (frame.index >= frame.value.length) {
          continue
        }

        // Read siblings lazily so getters and component invocation retain
        // authored left-to-right order during outer-shape resolution.
        const child = frame.value[frame.index]
        frames.push({ ...frame, index: frame.index + 1 })
        frames.push({
          contextScope: frame.contextScope,
          depth: frame.depth,
          kind: "resolve",
          value: child,
        })
        continue
      }

      const current = frame.value

      if (
        current === null ||
        current === undefined ||
        typeof current === "boolean"
      ) {
        continue
      }

      if (Array.isArray(current)) {
        if (activeValues.has(current)) {
          throw new EvaluationError(
            "<Loop> render arrays cannot contain cycles",
          )
        }

        activeValues.add(current)
        frames.push({ kind: "release", value: current })
        frames.push({
          contextScope: frame.contextScope,
          depth: frame.depth,
          index: 0,
          kind: "array",
          value: current,
        })
        continue
      }

      if (AmlNode.is(current)) {
        const nodeDepth = frame.depth + 1

        if (
          this.#maxDepth !== 0 &&
          nodeDepth > this.#maxDepth
        ) {
          throw new EvaluationError(
            `AML evaluation exceeded maxDepth ${this.#maxDepth}`,
          )
        }

        if (activeValues.has(current)) {
          throw new EvaluationError(
            "<Loop> render nodes cannot contain cycles",
          )
        }

        if (typeof current.type !== "function") {
          throw new EvaluationError(
            "<Loop> render must resolve to exactly one <Agent>",
          )
        }

        const primitiveKind = AmlNode.primitiveKind(current.type)

        if (primitiveKind === "agent") {
          if (selection !== undefined) {
            throw new EvaluationError(
              "<Loop> render must resolve to exactly one <Agent>",
            )
          }

          // Capture the wrapper ancestry before its release frames run. Agent
          // child evaluation uses it to preserve cross-boundary cycle checks.
          selection = Object.freeze({
            activeAncestors: new Set(activeValues),
            agent: current as AmlNode<AgentProps>,
            contextScope: frame.contextScope,
            parentDepth: frame.depth,
          })
          continue
        }

        // Context Provider is the only built-in wrapper that can be selected
        // without executing Agent children or acquiring a runtime resource.
        if (primitiveKind === "context") {
          const binding = ContextRegistry.captureProvider(
            current.type,
            current.props,
          )

          activeValues.add(current)
          frames.push({ kind: "release", value: current })
          frames.push({
            contextScope: frame.contextScope.provide(
              binding.definition,
              binding.value,
            ),
            depth: nodeDepth,
            kind: "resolve",
            value: binding.children,
          })
          continue
        }

        // Every other built-in primitive owns execution behavior rather than
        // transparent composition and is invalid around a Loop's outer Agent.
        if (primitiveKind !== undefined) {
          throw new EvaluationError(
            "<Loop> render must resolve to exactly one <Agent>",
          )
        }

        activeValues.add(current)
        frames.push({ kind: "release", value: current })

        const componentOutput =
          await ComponentEvaluationContext.invoke(
            () => current.type(current.props),
            async (nestedValue, nestedSchema) =>
              await evaluateNested(
                nestedValue,
                nestedSchema,
                nodeDepth,
                new Set(activeValues),
                frame.contextScope,
              ),
            frame.contextScope,
          )

        signal.throwIfAborted()
        frames.push({
          contextScope: frame.contextScope,
          depth: nodeDepth,
          kind: "resolve",
          value: componentOutput as AmlRenderable,
        })
        continue
      }

      if (typeof current === "object" && current !== null) {
        const then: unknown = Reflect.get(current, "then")

        if (typeof then === "function") {
          // Match the main evaluator's one-read custom-thenable semantics.
          const resolved = await new Promise<unknown>(
            (resolve, reject) => {
              queueMicrotask(() => {
                try {
                  Reflect.apply(then, current, [resolve, reject])
                } catch (error) {
                  reject(error)
                }
              })
            },
          )

          signal.throwIfAborted()
          frames.push({
            contextScope: frame.contextScope,
            depth: frame.depth,
            kind: "resolve",
            value: resolved as AmlRenderable,
          })
          continue
        }
      }

      // Text and numbers are output, not transparent wrappers around an Agent.
      throw new EvaluationError(
        "<Loop> render must resolve to exactly one <Agent>",
      )
    }

    if (selection === undefined) {
      throw new EvaluationError(
        "<Loop> render must resolve to exactly one <Agent>",
      )
    }

    return selection
  }
}
