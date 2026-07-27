import type { AgentProps } from "../components/agent/agent.js"
import type { AgentProvider } from "../components/agent/agent-provider.js"
import { AgentExecutor } from "../components/agent/agent-executor.js"
import { ModelSchema } from "../components/agent/model-schema.js"
import type { ValidatedAgentProvider } from "../components/agent/validate-agent-provider.js"
import type { FollowUpProps } from "../components/follow-up/follow-up.js"
import { McpCollection } from "../components/mcp/mcp-collection.js"
import type { McpProps } from "../components/mcp/mcp.js"
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
import {
  type WorkspaceEvaluationScope,
  WorkspaceEvaluator,
} from "../components/workspace/workspace-evaluator.js"
import type {
  WorkspaceMaterializationReference,
  WorkspaceProvider,
} from "../components/workspace/workspace-provider.js"
import type { WorkspaceProps } from "../components/workspace/workspace.js"
import { AmlNode, type AmlRenderable } from "./aml-node.js"
import { ComponentEvaluationContext } from "./component-evaluation-context.js"
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
  readonly source: "evaluation" | "follow-up" | "skill" | "system"
  readonly structured: StructuredEvaluation | undefined
  readonly workspace:
    | Readonly<WorkspaceMaterializationReference>
    | undefined
}

interface AgentTarget {
  readonly acceptsMessageDescriptors: boolean
  readonly followUps: string[]
  readonly kind: "agent"
  readonly mcpServers: McpCollection
  readonly parentSpanId: string
  readonly promptChunks: string[]
  readonly sandbox: Readonly<SandboxSession> | undefined
  readonly structured: StructuredEvaluation | undefined
  readonly systemFragments: string[]
  readonly tools: ToolCollection
  readonly workspace:
    | Readonly<WorkspaceMaterializationReference>
    | undefined
}

type ResolutionTarget = AgentTarget | TextTarget

/**
 * Mutable result slot owned by one schema-bearing evaluate() call.
 *
 * The collector travels through wrapper components solely to count Agents. Only
 * the Agent whose result targets the evaluation root receives the schema.
 */
interface StructuredEvaluation {
  agentCount: number
  hasResult: boolean
  result: unknown
  readonly schema: ModelSchema<unknown>
}

/**
 * State shared by every component-local evaluation in one root domain.
 */
interface EvaluationDomain {
  readonly context: EvaluationContext
  workspaceDeclared: boolean
}

/**
 * Lexical execution state inherited by a component-local evaluation.
 */
interface EvaluationScope {
  readonly depth: number
  readonly parentSpanId: string | undefined
  readonly sandbox: Readonly<SandboxSession> | undefined
  readonly workspace:
    | Readonly<WorkspaceMaterializationReference>
    | undefined
}

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
  readonly schema: ModelSchema<unknown> | undefined
  readonly sandbox: Readonly<SandboxSession> | undefined
  readonly target: ResolutionTarget
  readonly trace: AmlTraceIdentity
}

interface CompleteFollowUpFrame {
  readonly kind: "complete-follow-up"
  readonly parent: AgentTarget
  readonly target: TextTarget
}

interface CompleteSandboxFrame {
  readonly kind: "complete-sandbox"
  readonly scope: Readonly<SandboxEvaluationScope>
}

interface CompleteWorkspaceFrame {
  readonly kind: "complete-workspace"
  readonly scope: Readonly<WorkspaceEvaluationScope>
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
  | CompleteFollowUpFrame
  | CompleteSandboxFrame
  | CompleteSkillFrame
  | CompleteSystemFrame
  | CompleteWorkspaceFrame
  | ReleaseFrame
  | ResolveFrame

/**
 * Immutable provider defaults, capability policy, and safety limits for a runtime.
 */
export interface AmlRuntimeOptions {
  /**
   * Optional exact-name MCP server allowlist.
   */
  readonly allowedMcpServers?: readonly string[]

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
   * Maximum active Agent provider calls. Zero disables the limit.
   */
  readonly maxConcurrentAgents?: number

  /**
   * Maximum nested JSX node depth. Zero disables the limit.
   *
   * Arrays and Promises do not add semantic depth; Fragments and components do.
   */
  readonly maxDepth?: number

  /**
   * Maximum authored inputs in one Agent session. Zero disables the limit.
   */
  readonly maxTurnsPerAgent?: number

  /**
   * Default provider for outer Sandboxes without an explicit provider prop.
   */
  readonly sandboxProvider?: SandboxProvider

  /**
   * First system fragment supplied to every Agent in this runtime.
   */
  readonly system?: string

  /**
   * Default provider for the one top-level Workspace in an evaluation.
   */
  readonly workspaceProvider?: WorkspaceProvider
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
  readonly #allowedMcpServers: ReadonlySet<string> | undefined
  readonly #allowedTools: ReadonlySet<string> | undefined
  readonly #maxAgentCalls: number
  readonly #maxConcurrentAgents: number
  readonly #maxDepth: number
  readonly #sandboxEvaluator: SandboxEvaluator
  readonly #skillEvaluator: SkillEvaluator
  readonly #workspaceEvaluator: WorkspaceEvaluator

  /**
   * Captures one immutable set of runtime limits and Agent defaults.
   */
  constructor(options: AmlRuntimeOptions = {}) {
    const maxAgentCalls = options.maxAgentCalls ?? 32
    const maxConcurrentAgents = options.maxConcurrentAgents ?? 4
    const maxDepth = options.maxDepth ?? 16
    const maxTurnsPerAgent = options.maxTurnsPerAgent ?? 16

    if (!Number.isSafeInteger(maxAgentCalls) || maxAgentCalls < 0) {
      throw new TypeError(
        "maxAgentCalls must be a non-negative safe integer",
      )
    }

    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
      throw new TypeError("maxDepth must be a non-negative safe integer")
    }

    if (
      !Number.isSafeInteger(maxConcurrentAgents) ||
      maxConcurrentAgents < 0
    ) {
      throw new TypeError(
        "maxConcurrentAgents must be a non-negative safe integer",
      )
    }

    if (
      !Number.isSafeInteger(maxTurnsPerAgent) ||
      maxTurnsPerAgent < 0
    ) {
      throw new TypeError(
        "maxTurnsPerAgent must be a non-negative safe integer",
      )
    }

    this.#allowedMcpServers = captureAllowedNames(
      options.allowedMcpServers,
      "allowedMcpServers",
    )
    this.#allowedTools = captureAllowedNames(
      options.allowedTools,
      "allowedTools",
    )
    this.#agentExecutor = new AgentExecutor({
      ...(options.agentProvider === undefined
        ? {}
        : { agentProvider: options.agentProvider }),
      maxTurnsPerAgent,
      ...(options.system === undefined ? {} : { system: options.system }),
    })
    this.#maxAgentCalls = maxAgentCalls
    this.#maxConcurrentAgents = maxConcurrentAgents
    this.#maxDepth = maxDepth
    this.#sandboxEvaluator = new SandboxEvaluator(
      options.sandboxProvider,
    )
    this.#skillEvaluator = new SkillEvaluator(
      options.cwd ?? process.cwd(),
    )
    this.#workspaceEvaluator = new WorkspaceEvaluator(
      options.workspaceProvider,
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
    const domain: EvaluationDomain = {
      context: new EvaluationContext(
        this.#maxAgentCalls,
        this.#maxConcurrentAgents,
        signal,
      ),
      workspaceDeclared: false,
    }

    try {
      return (await this.#evaluateInDomain(
        value,
        domain,
        {
          depth: 0,
          parentSpanId: undefined,
          sandbox: undefined,
          workspace: undefined,
        },
        undefined,
      )) as string
    } finally {
      domain.context.close()
    }
  }

  /**
   * Resolves one root or component-local subtree inside an existing domain.
   *
   * Each invocation owns resources it acquires, but inherits the caller's
   * lexical Sandbox, Workspace, depth, trace parent, budgets, and cancellation.
   */
  async #evaluateInDomain(
    value: AmlRenderable,
    domain: EvaluationDomain,
    scope: EvaluationScope,
    schema: ModelSchema<unknown> | undefined,
    activeAncestors: ReadonlySet<object> = new Set(),
  ): Promise<unknown> {
    const context = domain.context
    // Component-local evaluate() starts a new frame stack, but it remains on
    // the caller's logical branch. Copying its ancestry preserves cycle
    // detection while keeping concurrent nested calls independent.
    const activeValues = new Set(activeAncestors)
    const activeSandboxScopes: SandboxEvaluationScope[] = []
    let activeWorkspaceScope: WorkspaceEvaluationScope | undefined
    const structured: StructuredEvaluation | undefined =
      schema === undefined
        ? undefined
        : {
            agentCount: 0,
            hasResult: false,
            result: undefined,
            schema,
          }
    const output: TextTarget = {
      chunks: [],
      kind: "text",
      parentSpanId: scope.parentSpanId,
      sandbox: scope.sandbox,
      source: "evaluation",
      structured,
      workspace: scope.workspace,
    }
    const frames: EvaluationFrame[] = [
      { depth: scope.depth, kind: "resolve", target: output, value },
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

          context.signal.throwIfAborted()
          continue
        }

        if (frame.kind === "complete-workspace") {
          if (activeWorkspaceScope !== frame.scope) {
            throw new EvaluationError(
              "Workspace scopes completed out of lifecycle order",
            )
          }

          // Remove ownership before completion so a save or release failure is
          // never retried by the outer cleanup path.
          activeWorkspaceScope = undefined

          try {
            await frame.scope.complete()
          } catch (completionError) {
            if (context.signal.aborted) {
              throw new AggregateError(
                [context.signal.reason, completionError],
                "AML evaluation was cancelled and Workspace completion failed",
              )
            }

            throw completionError
          }

          context.signal.throwIfAborted()
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

        if (frame.kind === "complete-follow-up") {
          const text = frame.target.chunks.join("").trim()

          if (text.length === 0) {
            throw new EvaluationError(
              "<FollowUp> must resolve to non-empty text",
            )
          }

          frame.parent.followUps.push(text)
          continue
        }

        if (frame.kind === "complete-skill") {
          const content = await this.#skillEvaluator.complete(
            frame.plan,
            frame.text.chunks.join(""),
            context.signal,
          )

          appendText(frame.target, content)

          continue
        }

        if (frame.kind === "complete-agent") {
          // A completion frame runs only after every child has contributed text,
          // System fragments, Tool descriptors, or MCP grants to the Agent plan.
          const response = await this.#agentExecutor.execute({
            context,
            followUps: frame.plan.followUps,
            mcpServers: frame.plan.mcpServers.values(),
            ...(frame.schema === undefined
              ? {}
              : { output: frame.schema }),
            prompt: frame.plan.promptChunks.join(""),
            provider: frame.provider,
            props: frame.props,
            sandbox: frame.sandbox,
            systemFragments: frame.plan.systemFragments,
            tools: frame.plan.tools.values(),
            trace: frame.trace,
          })

          if (frame.schema !== undefined) {
            const collector = frame.target.structured

            if (collector === undefined) {
              throw new EvaluationError(
                "Structured Agent completed without an evaluation collector",
              )
            }

            // AgentExecutor requires and validates this field whenever it
            // receives a ModelSchema, including transformed undefined output.
            collector.hasResult = true
            collector.result = response.structured
          } else {
            appendText(frame.target, response.text)
          }

          continue
        }

        // Everything below handles a resolve frame. Scalars append immediately;
        // containers and nodes schedule more frames instead of recursing.
        const current = frame.value

        if (typeof current === "string") {
          appendText(frame.target, current)
          continue
        }

        if (typeof current === "number") {
          appendText(frame.target, String(current))
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
            const collector = frame.target.structured

            if (collector !== undefined) {
              collector.agentCount += 1

              if (collector.agentCount > 1) {
                throw new EvaluationError(
                  "Structured evaluate() must resolve to exactly one <Agent>",
                )
              }
            }

            const props = current.props as Readonly<AgentProps>
            const provider = this.#agentExecutor.validateProps(props)
            const sandbox = this.#sandboxEvaluator.forAgent(
              frame.target.sandbox,
              props.cwd,
            )

            const trace = context.createTrace(frame.target.parentSpanId)
            const plan: AgentTarget = {
              acceptsMessageDescriptors: true,
              followUps: [],
              kind: "agent",
              mcpServers: new McpCollection(this.#allowedMcpServers),
              parentSpanId: trace.spanId,
              promptChunks: [],
              sandbox: frame.target.sandbox,
              structured: frame.target.structured,
              systemFragments: [],
              tools: new ToolCollection(this.#allowedTools),
              workspace: frame.target.workspace,
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
              schema:
                collector !== undefined &&
                frame.target.kind === "text" &&
                frame.target.source === "evaluation"
                  ? collector.schema
                  : undefined,
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

          // <FollowUp> redirects its children into one later user-message
          // channel while the containing Agent still resolves post-order.
          if (primitiveKind === "follow-up") {
            if (
              frame.target.kind !== "agent" ||
              !frame.target.acceptsMessageDescriptors
            ) {
              const placement =
                frame.target.kind === "text" &&
                frame.target.source === "follow-up"
                  ? "nested <FollowUp> descriptors are invalid"
                  : frame.target.kind === "agent"
                    ? "<FollowUp> must be an immediate message descriptor of <Agent>"
                    : "<FollowUp> is only valid inside <Agent>"
              throw new EvaluationError(placement)
            }

            const props = current.props as Readonly<FollowUpProps>
            const followUpTarget: TextTarget = {
              chunks: [],
              kind: "text",
              parentSpanId: frame.target.parentSpanId,
              sandbox: frame.target.sandbox,
              source: "follow-up",
              structured: frame.target.structured,
              workspace: frame.target.workspace,
            }

            activeValues.add(current)
            frames.push({ kind: "release", value: current })
            frames.push({
              kind: "complete-follow-up",
              parent: frame.target,
              target: followUpTarget,
            })
            frames.push({
              depth: nodeDepth,
              kind: "resolve",
              target: followUpTarget,
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
              frame.target.workspace,
              trace.runId,
              context.signal,
            )
            const scopedTarget: ResolutionTarget = {
              ...frame.target,
              // A lexical resource primitive remains visible after component
              // expansion, so descriptors beneath it are not immediate Agent
              // messages. A nested Agent creates its own direct message scope.
              ...(frame.target.kind === "agent"
                ? { acceptsMessageDescriptors: false }
                : {}),
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

          // <Workspace> is the one top-level durable resource boundary. It
          // cannot hide inside prompt assembly or another resource scope.
          if (primitiveKind === "workspace") {
            if (domain.workspaceDeclared) {
              throw new EvaluationError(
                "An AML evaluation may contain at most one <Workspace>",
              )
            }

            if (
              frame.target.kind !== "text" ||
              frame.target.source !== "evaluation" ||
              frame.target.sandbox !== undefined ||
              frame.target.workspace !== undefined
            ) {
              throw new EvaluationError(
                "<Workspace> must be a top-level resource boundary",
              )
            }

            domain.workspaceDeclared = true
            const props = current.props as Readonly<WorkspaceProps>
            const trace = context.createTrace(
              frame.target.parentSpanId,
            )
            const scope = await this.#workspaceEvaluator.enter(
              props,
              trace.runId,
              context.signal,
            )
            const scopedTarget: TextTarget = {
              ...frame.target,
              parentSpanId: trace.spanId,
              workspace: scope.materialization,
            }

            activeWorkspaceScope = scope
            activeValues.add(current)
            frames.push({ kind: "release", value: current })
            frames.push({
              kind: "complete-workspace",
              scope,
            })
            frames.push({
              depth: nodeDepth,
              kind: "resolve",
              target: scopedTarget,
              value: props.children,
            })
            continue
          }

          // <Mcp> is metadata for the nearest Agent, not prompt text.
          if (primitiveKind === "mcp") {
            if (frame.target.kind !== "agent") {
              if (frame.target.source === "follow-up") {
                throw new EvaluationError(
                  "<Mcp> is invalid inside <FollowUp>",
                )
              }

              throw new EvaluationError(
                "<Mcp> is only valid inside <Agent>",
              )
            }

            // MCP descriptors mutate only the nearest Agent plan. Providers
            // perform attachment later at the complete-session boundary.
            frame.target.mcpServers.add(
              current.props as Readonly<McpProps>,
            )
            continue
          }

          // <Tool> is metadata for the nearest Agent, not prompt text.
          if (primitiveKind === "tool") {
            if (frame.target.kind !== "agent") {
              if (frame.target.source === "follow-up") {
                throw new EvaluationError(
                  "<Tool> is invalid inside <FollowUp>",
                )
              }

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
              structured: frame.target.structured,
              workspace: frame.target.workspace,
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
              structured: frame.target.structured,
              workspace: frame.target.workspace,
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
          const componentOutput =
            await ComponentEvaluationContext.invoke(
              () => current.type(current.props),
              async (nestedValue, nestedSchema) => {
                context.signal.throwIfAborted()

                // A nested schema is captured before its provider boundary.
                // Both calls remain in this domain and inherit only lexical
                // execution resources, never the parent Agent's capabilities.
                const modelSchema =
                  nestedSchema === undefined
                    ? undefined
                    : new ModelSchema(nestedSchema)

                return await this.#evaluateInDomain(
                  nestedValue,
                  domain,
                  {
                    depth: nodeDepth,
                    parentSpanId: frame.target.parentSpanId,
                    sandbox: frame.target.sandbox,
                    workspace: frame.target.workspace,
                  },
                  modelSchema,
                  new Set(activeValues),
                )
              },
            )

          context.signal.throwIfAborted()
          frames.push({
            depth: nodeDepth,
            kind: "resolve",
            target: frame.target,
            value: componentOutput as AmlRenderable,
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

      if (activeWorkspaceScope !== undefined) {
        const scope = activeWorkspaceScope
        activeWorkspaceScope = undefined

        try {
          await scope.complete()
        } catch (completionError) {
          releaseErrors.push(completionError)
        }
      }

      if (releaseErrors.length > 0) {
        throw new AggregateError(
          [error, ...releaseErrors],
          "AML evaluation and resource cleanup both failed",
        )
      }

      throw error
    }

    if (structured !== undefined) {
      if (structured.agentCount !== 1 || !structured.hasResult) {
        throw new EvaluationError(
          "Structured evaluate() must resolve to exactly one <Agent>",
        )
      }

      return structured.result
    }

    return output.chunks.join("")
  }
}

/**
 * Appends text through the channel selected by one resolution target.
 */
function appendText(target: ResolutionTarget, value: string): void {
  if (target.kind === "agent") {
    // FollowUps are a trailing message section. Formatting whitespace between
    // descriptors is harmless, but later initial-prompt text is ambiguous.
    if (target.followUps.length > 0) {
      if (value.trim().length > 0) {
        throw new EvaluationError(
          "non-whitespace Agent text cannot follow <FollowUp>",
        )
      }

      return
    }

    target.promptChunks.push(value)
    return
  }

  // Structured evaluation returns an Agent's typed value, so adjacent rendered
  // text would create a second incompatible result channel.
  if (
    target.structured !== undefined &&
    target.source === "evaluation" &&
    value.length > 0
  ) {
    throw new EvaluationError(
      "Structured evaluate() cannot include text outside its <Agent>",
    )
  }

  target.chunks.push(value)
}

/**
 * Captures one normalized exact-name capability allowlist for a runtime.
 */
function captureAllowedNames(
  values: readonly string[] | undefined,
  label: "allowedMcpServers" | "allowedTools",
): ReadonlySet<string> | undefined {
  if (values === undefined) {
    return undefined
  }

  if (!Array.isArray(values)) {
    throw new TypeError(`${label} must be an array`)
  }

  const result = new Set<string>()

  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value !== value.trim()
    ) {
      throw new TypeError(
        `${label} entries must be non-empty normalized strings`,
      )
    }

    result.add(value)
  }

  return result
}
