import type { AgentProps } from "../components/agent/agent.js"
import type { AgentProvider } from "../components/agent/agent-provider.js"
import { AgentExecutor } from "../components/agent/agent-executor.js"
import type { ValidatedAgentProvider } from "../components/agent/validate-agent-provider.js"
import type { SystemProps } from "../components/system/system.js"
import { AmlNode, type AmlRenderable } from "./aml-node.js"
import { EvaluationContext } from "./evaluation-context.js"
import { EvaluationError } from "./evaluation-error.js"
import type { AmlTraceIdentity } from "./trace-identity.js"

interface TextTarget {
  readonly chunks: string[]
  readonly kind: "text"
  readonly parentSpanId: string | undefined
  readonly source: "evaluation" | "system"
}

interface AgentTarget {
  readonly kind: "agent"
  readonly parentSpanId: string
  readonly promptChunks: string[]
  readonly systemFragments: string[]
}

type ResolutionTarget = AgentTarget | TextTarget

interface ResolveFrame {
  readonly depth: number
  readonly kind: "resolve"
  readonly target: ResolutionTarget
  readonly value: AmlRenderable
}

interface ArrayFrame {
  readonly depth: number
  readonly index: number
  readonly kind: "array"
  readonly target: ResolutionTarget
  readonly value: readonly AmlRenderable[]
}

interface ReleaseFrame {
  readonly kind: "release"
  readonly value: object
}

interface CompleteAgentFrame {
  readonly kind: "complete-agent"
  readonly plan: AgentTarget
  readonly props: Readonly<AgentProps>
  readonly provider: Readonly<ValidatedAgentProvider> | undefined
  readonly target: ResolutionTarget
  readonly trace: AmlTraceIdentity
}

interface CompleteSystemFrame {
  readonly kind: "complete-system"
  readonly parent: AgentTarget
  readonly target: TextTarget
}

type EvaluationFrame =
  | ArrayFrame
  | CompleteAgentFrame
  | CompleteSystemFrame
  | ReleaseFrame
  | ResolveFrame

export interface AmlRuntimeOptions {
  /**
   * Default provider for Agents without an explicit provider prop.
   */
  readonly agentProvider?: AgentProvider

  /**
   * Maximum provider-backed Agent sessions. Zero disables the limit.
   */
  readonly maxAgentCalls?: number

  /**
   * Maximum nested JSX node depth. Zero disables the limit.
   *
   * Arrays and Promises do not add semantic depth; Fragments and components do.
   */
  readonly maxDepth?: number

  /**
   * First system fragment supplied to every Agent in this runtime.
   */
  readonly system?: string
}

export interface AmlEvaluationOptions {
  /**
   * Caller-owned cancellation signal for this complete evaluation.
   */
  readonly signal?: AbortSignal
}

/**
 * Evaluates one authored AML tree into its final text.
 */
export class AmlRuntime {
  readonly #agentExecutor: AgentExecutor
  readonly #maxAgentCalls: number
  readonly #maxDepth: number

  constructor(options: AmlRuntimeOptions = {}) {
    const maxAgentCalls = options.maxAgentCalls ?? 32
    const maxDepth = options.maxDepth ?? 16

    if (!Number.isSafeInteger(maxAgentCalls) || maxAgentCalls < 0) {
      throw new TypeError(
        "maxAgentCalls must be a non-negative safe integer",
      )
    }

    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
      throw new TypeError("maxDepth must be a non-negative safe integer")
    }

    this.#agentExecutor = new AgentExecutor({
      ...(options.agentProvider === undefined
        ? {}
        : { agentProvider: options.agentProvider }),
      ...(options.system === undefined ? {} : { system: options.system }),
    })
    this.#maxAgentCalls = maxAgentCalls
    this.#maxDepth = maxDepth
  }

  async evaluate(
    value: AmlRenderable,
    options: AmlEvaluationOptions = {},
  ): Promise<string> {
    const signal = options.signal ?? new AbortController().signal
    signal.throwIfAborted()

    const context = new EvaluationContext(this.#maxAgentCalls, signal)
    const activeValues = new Set<object>()
    const output: TextTarget = {
      chunks: [],
      kind: "text",
      parentSpanId: undefined,
      source: "evaluation",
    }
    const frames: EvaluationFrame[] = [
      { depth: 0, kind: "resolve", target: output, value },
    ]

    while (frames.length > 0) {
      context.signal.throwIfAborted()

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

        // Read one sibling only when its authored turn reaches the stack top.
        // This preserves getter, mutation, and component start order.
        const child = frame.value[frame.index]
        frames.push({ ...frame, index: frame.index + 1 })
        frames.push({
          depth: frame.depth,
          kind: "resolve",
          target: frame.target,
          value: child,
        })
        continue
      }

      if (frame.kind === "complete-system") {
        const text = frame.target.chunks.join("").trim()

        if (text.length === 0) {
          throw new EvaluationError(
            "<System> must resolve to non-empty text",
          )
        }

        frame.parent.systemFragments.push(text)
        continue
      }

      if (frame.kind === "complete-agent") {
        const response = await this.#agentExecutor.execute({
          context,
          prompt: frame.plan.promptChunks.join(""),
          provider: frame.provider,
          props: frame.props,
          systemFragments: frame.plan.systemFragments,
          trace: frame.trace,
        })

        if (frame.target.kind === "agent") {
          frame.target.promptChunks.push(response)
        } else {
          frame.target.chunks.push(response)
        }

        continue
      }

      const current = frame.value

      if (typeof current === "string") {
        if (frame.target.kind === "agent") {
          frame.target.promptChunks.push(current)
        } else {
          frame.target.chunks.push(current)
        }

        continue
      }

      if (typeof current === "number") {
        if (frame.target.kind === "agent") {
          frame.target.promptChunks.push(String(current))
        } else {
          frame.target.chunks.push(String(current))
        }

        continue
      }

      if (
        current === null ||
        current === undefined ||
        typeof current === "boolean"
      ) {
        continue
      }

      if (Array.isArray(current)) {
        if (activeValues.has(current)) {
          throw new EvaluationError("AML arrays cannot contain cycles")
        }

        activeValues.add(current)
        frames.push({ kind: "release", value: current })
        frames.push({
          depth: frame.depth,
          index: 0,
          kind: "array",
          target: frame.target,
          value: current,
        })

        continue
      }

      if (AmlNode.is(current)) {
        const nodeDepth = frame.depth + 1

        if (this.#maxDepth !== 0 && nodeDepth > this.#maxDepth) {
          throw new EvaluationError(
            `AML evaluation exceeded maxDepth ${this.#maxDepth}`,
          )
        }

        if (activeValues.has(current)) {
          throw new EvaluationError("AML nodes cannot contain cycles")
        }

        if (typeof current.type !== "function") {
          throw new EvaluationError(
            "AML does not support intrinsic or unknown JSX element types",
          )
        }

        const primitiveKind = AmlNode.primitiveKind(current.type)

        if (primitiveKind === "agent") {
          const props = current.props as Readonly<AgentProps>
          const provider = this.#agentExecutor.validateProps(props)

          const trace = context.createTrace(frame.target.parentSpanId)
          const plan: AgentTarget = {
            kind: "agent",
            parentSpanId: trace.spanId,
            promptChunks: [],
            systemFragments: [],
          }

          activeValues.add(current)
          frames.push({ kind: "release", value: current })
          frames.push({
            kind: "complete-agent",
            plan,
            props,
            provider,
            target: frame.target,
            trace,
          })
          frames.push({
            depth: nodeDepth,
            kind: "resolve",
            target: plan,
            value: props.children,
          })
          continue
        }

        if (primitiveKind === "system") {
          if (frame.target.kind !== "agent") {
            const placement =
              frame.target.source === "system"
                ? "nested <System> descriptors are invalid"
                : "<System> is only valid inside <Agent>"
            throw new EvaluationError(placement)
          }

          const props = current.props as Readonly<SystemProps>
          const systemTarget: TextTarget = {
            chunks: [],
            kind: "text",
            parentSpanId: frame.target.parentSpanId,
            source: "system",
          }

          activeValues.add(current)
          frames.push({ kind: "release", value: current })
          frames.push({
            kind: "complete-system",
            parent: frame.target,
            target: systemTarget,
          })
          frames.push({
            depth: nodeDepth,
            kind: "resolve",
            target: systemTarget,
            value: props.children,
          })
          continue
        }

        activeValues.add(current)
        frames.push({ kind: "release", value: current })
        frames.push({
          depth: nodeDepth,
          kind: "resolve",
          target: frame.target,
          value: current.type(current.props),
        })
        continue
      }

      if (typeof current === "object" && current !== null) {
        const then: unknown = (current as { readonly then?: unknown }).then

        if (typeof then === "function") {
          // Native await reads `then` now but invokes it in a later job. Keep
          // that timing while still reading stateful accessors exactly once.
          const resolved = await new Promise<unknown>((resolve, reject) => {
            queueMicrotask(() => {
              try {
                Reflect.apply(then, current, [resolve, reject])
              } catch (error) {
                reject(error)
              }
            })
          })

          frames.push({
            depth: frame.depth,
            kind: "resolve",
            target: frame.target,
            value: resolved as AmlRenderable,
          })
          continue
        }
      }

      throw new EvaluationError(
        `AML cannot render a value of type ${typeof current}`,
      )
    }

    return output.chunks.join("")
  }
}
