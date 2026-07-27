import type { AgentProps } from "../components/agent/agent.js"
import type { AgentProvider } from "../components/agent/agent-provider.js"
import { AgentExecutor } from "../components/agent/agent-executor.js"
import type { ValidatedAgentProvider } from "../components/agent/validate-agent-provider.js"
import {
  type SandboxEvaluationScope,
  SandboxEvaluator,
} from "../components/sandbox/sandbox-evaluator.js"
import type {
  SandboxProvider,
  SandboxSession,
} from "../components/sandbox/sandbox-provider.js"
import type { SandboxProps } from "../components/sandbox/sandbox.js"
import {
  type SkillEvaluation,
  SkillEvaluator,
} from "../components/skill/skill-evaluator.js"
import type { SystemProps } from "../components/system/system.js"
import { ToolCollection } from "../components/tool/tool-collection.js"
import type { ToolProps } from "../components/tool/tool.js"
import { AmlNode, type AmlRenderable } from "./aml-node.js"
import { EvaluationContext } from "./evaluation-context.js"
import { EvaluationError } from "./evaluation-error.js"
import type { AmlTraceIdentity } from "./trace-identity.js"

// Resolution targets keep prompt assembly separate from ordinary text output.
// That distinction lets descriptors such as <Tool> and <System> mutate only the
// nearest Agent plan while ordinary values preserve their authored position.
interface TextTarget {
  readonly chunks: string[]
  readonly kind: "text"
  readonly parentSpanId: string | undefined
  readonly sandbox: Readonly<SandboxSession> | undefined
  readonly source: "evaluation" | "skill" | "system"
}

interface AgentTarget {
  readonly kind: "agent"
  readonly parentSpanId: string
  readonly promptChunks: string[]
  readonly sandbox: Readonly<SandboxSession> | undefined
  readonly systemFragments: string[]
  readonly tools: ToolCollection
}

type ResolutionTarget = AgentTarget | TextTarget

// Evaluation frames encode the recursive AML algorithm as an explicit stack.
// Completion frames are pushed before their children and therefore run after
// those children have fully resolved.
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
  readonly sandbox: Readonly<SandboxSession> | undefined
  readonly target: ResolutionTarget
  readonly trace: AmlTraceIdentity
}

interface CompleteSandboxFrame {
  readonly kind: "complete-sandbox"
  readonly scope: Readonly<SandboxEvaluationScope>
}

interface CompleteSystemFrame {
  readonly kind: "complete-system"
  readonly parent: AgentTarget
  readonly target: TextTarget
}

interface CompleteSkillFrame {
  readonly kind: "complete-skill"
  readonly plan: SkillEvaluation
  readonly target: ResolutionTarget
  readonly text: TextTarget
}

type EvaluationFrame =
  | ArrayFrame
  | CompleteAgentFrame
  | CompleteSandboxFrame
  | CompleteSkillFrame
  | CompleteSystemFrame
  | ReleaseFrame
  | ResolveFrame

/**
 * Immutable provider defaults, capability policy, and safety limits for a runtime.
 */
export interface AmlRuntimeOptions {
  /**
   * Optional exact-name capability allowlist.
   */
  readonly allowedTools?: readonly string[]

  /**
   * Default provider for Agents without an explicit provider prop.
   */
  readonly agentProvider?: AgentProvider

  /**
   * Base directory for relative local Skill files.
   */
  readonly cwd?: string

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
   * Default provider for outer Sandboxes without an explicit provider prop.
   */
  readonly sandboxProvider?: SandboxProvider

  /**
   * First system fragment supplied to every Agent in this runtime.
   */
  readonly system?: string
}

/**
 * Per-call controls that must not leak between concurrent evaluations.
 */
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
  readonly #allowedTools: ReadonlySet<string> | undefined
  readonly #maxAgentCalls: number
  readonly #maxDepth: number
  readonly #sandboxEvaluator: SandboxEvaluator
  readonly #skillEvaluator: SkillEvaluator

  /**
   * Captures one immutable set of runtime limits and Agent defaults.
   */
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

    this.#allowedTools = captureAllowedTools(options.allowedTools)
    this.#agentExecutor = new AgentExecutor({
      ...(options.agentProvider === undefined
        ? {}
        : { agentProvider: options.agentProvider }),
      ...(options.system === undefined ? {} : { system: options.system }),
    })
    this.#maxAgentCalls = maxAgentCalls
    this.#maxDepth = maxDepth
    this.#sandboxEvaluator = new SandboxEvaluator(
      options.sandboxProvider,
    )
    this.#skillEvaluator = new SkillEvaluator(
      options.cwd ?? process.cwd(),
    )
  }

  /**
   * Resolves one AML tree post-order into its final string output.
   *
   * The evaluator uses an explicit frame stack so asynchronous components and
   * deeply nested trees do not depend on JavaScript recursion.
   */
  async evaluate(
    value: AmlRenderable,
    options: AmlEvaluationOptions = {},
  ): Promise<string> {
    const signal = options.signal ?? new AbortController().signal
    signal.throwIfAborted()

    // Each evaluation owns cancellation, limits, trace allocation, and cycle
    // tracking. No mutable execution state is shared between calls.
    const context = new EvaluationContext(this.#maxAgentCalls, signal)
    const activeValues = new Set<object>()
    const activeSandboxScopes: SandboxEvaluationScope[] = []
    const output: TextTarget = {
      chunks: [],
      kind: "text",
      parentSpanId: undefined,
      sandbox: undefined,
      source: "evaluation",
    }
    const frames: EvaluationFrame[] = [
      { depth: 0, kind: "resolve", target: output, value },
    ]

    try {
      // The loop has two phases. Structural frames finish work scheduled by a
      // parent node; resolve frames classify and expand one AML value.
      while (frames.length > 0) {
        context.signal.throwIfAborted()

        const frame = frames.pop()

        if (!frame) {
          // The length guard proves a value exists at runtime, but Array.pop()
          // still exposes undefined in its TypeScript contract.
          break
        }

        // Release frames delimit cycle detection to the currently active branch.
        // Reusing an immutable node in two sequential branches remains valid.
        if (frame.kind === "release") {
          activeValues.delete(frame.value)
          continue
        }

        if (frame.kind === "complete-sandbox") {
          // Remove ownership before awaiting release. A release failure must not
          // make the outer cleanup path invoke the provider a second time.
          const scope = activeSandboxScopes.pop()

          if (scope !== frame.scope) {
            throw new EvaluationError(
              "Sandbox scopes completed out of lifecycle order",
            )
          }

          try {
            await frame.scope.release()
          } catch (releaseError) {
            // Cancellation can arrive after this frame removes ownership but
            // while provider cleanup is pending. Preserve both causes instead
            // of letting the later release failure mask caller control flow.
            if (context.signal.aborted) {
              throw new AggregateError(
                [context.signal.reason, releaseError],
                "AML evaluation was cancelled and Sandbox cleanup failed",
              )
            }

            throw releaseError
          }

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

        // Completion frames run post-order, after their child targets contain the
        // complete text or Agent execution plan.
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

        if (frame.kind === "complete-skill") {
          const content = await this.#skillEvaluator.complete(
            frame.plan,
            frame.text.chunks.join(""),
            context.signal,
          )

          if (frame.target.kind === "agent") {
            frame.target.promptChunks.push(content)
          } else {
            frame.target.chunks.push(content)
          }

          continue
        }

        if (frame.kind === "complete-agent") {
          // A completion frame runs only after every child has contributed text,
          // System fragments, or Tool descriptors to the Agent plan.
          const response = await this.#agentExecutor.execute({
            context,
            prompt: frame.plan.promptChunks.join(""),
            provider: frame.provider,
            props: frame.props,
            sandbox: frame.sandbox,
            systemFragments: frame.plan.systemFragments,
            tools: frame.plan.tools.values(),
            trace: frame.trace,
          })

          if (frame.target.kind === "agent") {
            frame.target.promptChunks.push(response)
          } else {
            frame.target.chunks.push(response)
          }

          continue
        }

        // Everything below handles a resolve frame. Scalars append immediately;
        // containers and nodes schedule more frames instead of recursing.
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

          // <Agent> creates a new capability and prompt scope. Its completion is
          // deliberately scheduled before its children on the LIFO stack.
          if (primitiveKind === "agent") {
            const props = current.props as Readonly<AgentProps>
            const provider = this.#agentExecutor.validateProps(props)
            const sandbox = this.#sandboxEvaluator.forAgent(
              frame.target.sandbox,
              props.cwd,
            )

            const trace = context.createTrace(frame.target.parentSpanId)
            const plan: AgentTarget = {
              kind: "agent",
              parentSpanId: trace.spanId,
              promptChunks: [],
              sandbox: frame.target.sandbox,
              systemFragments: [],
              tools: new ToolCollection(this.#allowedTools),
            }

            // Push completion before children: the LIFO stack gives AML its
            // bottom-up execution semantics without suspending a component.
            activeValues.add(current)
            frames.push({ kind: "release", value: current })
            frames.push({
              kind: "complete-agent",
              plan,
              props,
              provider,
              sandbox,
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

          // <Sandbox> is a lexical execution scope: the outer node acquires a
          // lease before children, while nested nodes only restrict that lease.
          if (primitiveKind === "sandbox") {
            const props = current.props as Readonly<SandboxProps>
            const trace = context.createTrace(frame.target.parentSpanId)
            const scope = await this.#sandboxEvaluator.enter(
            props,
            frame.target.sandbox,
            trace.runId,
            context.signal,
          )
            const scopedTarget: ResolutionTarget = {
              ...frame.target,
              parentSpanId: trace.spanId,
              sandbox: scope.session,
            }

            activeValues.add(current)
            frames.push({ kind: "release", value: current })

            if (scope.ownsLease) {
              // Root scopes are tracked separately so cancellation or any
              // descendant failure still reaches provider cleanup.
              activeSandboxScopes.push(scope)
              frames.push({ kind: "complete-sandbox", scope })
            }

            frames.push({
              depth: nodeDepth,
              kind: "resolve",
              target: scopedTarget,
              value: props.children,
            })
            continue
          }

          // <Tool> is metadata for the nearest Agent, not prompt text.
          if (primitiveKind === "tool") {
            if (frame.target.kind !== "agent") {
              throw new EvaluationError(
                "<Tool> is only valid inside <Agent>",
              )
            }

            // Tool descriptors mutate only the nearest Agent plan and never add
            // text to its initial prompt.
            frame.target.tools.add(
              current.props as Readonly<ToolProps>,
            )
            continue
          }

          // Skills combine an optional local file with post-order child text.
          // They remain prompt text rather than a provider-specific capability.
          if (primitiveKind === "skill") {
            const plan = this.#skillEvaluator.prepare(current.props)

            const skillTarget: TextTarget = {
              chunks: [],
              kind: "text",
              parentSpanId: frame.target.parentSpanId,
              sandbox: frame.target.sandbox,
              source: "skill",
            }

            activeValues.add(current)
            frames.push({ kind: "release", value: current })
            frames.push({
              kind: "complete-skill",
              plan,
              target: frame.target,
              text: skillTarget,
            })

            // Source-only Skills complete immediately; inline AML still follows
            // the evaluator's ordinary post-order and cycle semantics.
            if (plan.hasChildren) {
              frames.push({
                depth: nodeDepth,
                kind: "resolve",
                target: skillTarget,
                value: plan.children,
              })
            }

            continue
          }

          // <System> redirects its children into the nearest Agent's system
          // channel. Nested System scopes are ambiguous and rejected.
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
              sandbox: frame.target.sandbox,
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

          // User components are ordinary async factories. Invocation happens only
          // now so authoring JSX remains inert and evaluation owns all side effects.
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

        // Objects are not stringified implicitly: accepting them would make
        // prompts depend on JavaScript's lossy "[object Object]" coercion.
        throw new EvaluationError(
          `AML cannot render a value of type ${typeof current}`,
        )
      }
    } catch (error) {
      const releaseErrors: unknown[] = []

      // Resource cleanup is LIFO so future independently acquired scopes keep
      // the same ownership order as the evaluator frame stack.
      while (activeSandboxScopes.length > 0) {
        const scope = activeSandboxScopes.pop()

        if (!scope) {
          break
        }

        try {
          await scope.release()
        } catch (releaseError) {
          releaseErrors.push(releaseError)
        }
      }

      if (releaseErrors.length > 0) {
        throw new AggregateError(
          [error, ...releaseErrors],
          "AML evaluation and Sandbox cleanup both failed",
        )
      }

      throw error
    }

    return output.chunks.join("")
  }
}

/**
 * Captures a normalized exact-name Tool allowlist for one runtime.
 */
function captureAllowedTools(
  values: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (values === undefined) {
    return undefined
  }

  if (!Array.isArray(values)) {
    throw new TypeError("allowedTools must be an array")
  }

  const result = new Set<string>()

  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value !== value.trim()
    ) {
      throw new TypeError(
        "allowedTools entries must be non-empty normalized strings",
      )
    }

    result.add(value)
  }

  return result
}
