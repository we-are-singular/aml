import type { StandardSchemaV1 } from "@standard-schema/spec"

import type { AgentProps } from "../components/agent/agent.js"
import type { AgentProvider } from "../components/agent/agent-provider.js"
import { AgentExecutor } from "../components/agent/agent-executor.js"
import { ModelSchema } from "../components/agent/model-schema.js"
import type { ValidatedAgentProvider } from "../components/agent/validate-agent-provider.js"
import { type FileEvaluation, FileEvaluator } from "../components/file/file-evaluator.js"
import type { FileProps } from "../components/file/file.js"
import type { FollowUpProps } from "../components/follow-up/follow-up.js"
import { ContextRegistry } from "../components/context/context-registry.js"
import { ContextScope } from "../components/context/context-scope.js"
import { LoopAgentSelector } from "../components/loop/loop-agent-selector.js"
import { LoopEvaluator } from "../components/loop/loop-evaluator.js"
import type { LoopProps } from "../components/loop/loop.js"
import { McpCollection } from "../components/mcp/mcp-collection.js"
import type { McpProps } from "../components/mcp/mcp.js"
import { type SandboxEvaluationScope, SandboxEvaluator } from "../components/sandbox/sandbox-evaluator.js"
import type { SandboxProvider, SandboxSession } from "../components/sandbox/sandbox-provider.js"
import type { SandboxProps } from "../components/sandbox/sandbox.js"
import { type ScriptEvaluation, ScriptEvaluator } from "../components/script/script-evaluator.js"
import type { ScriptProps } from "../components/script/script.js"
import { type SkillEvaluation, SkillEvaluator } from "../components/skill/skill-evaluator.js"
import type { SystemProps } from "../components/system/system.js"
import { ToolCollection } from "../components/tool/tool-collection.js"
import { registeredAmlTool, type AgentJavaScriptTool, type AmlTool } from "../components/tool/agent-tool.js"
import { instrumentAgentTools } from "../components/tool/instrument-agent-tools.js"
import type { ToolProps } from "../components/tool/tool.js"
import { type WorkspaceEvaluationScope, WorkspaceEvaluator } from "../components/workspace/workspace-evaluator.js"
import type {
  WorkspaceMaterializationReference,
  WorkspaceProvider,
} from "../components/workspace/workspace-provider.js"
import type { WorkspaceProps } from "../components/workspace/workspace.js"
import { AmlNode, type AmlRenderable } from "./aml-node.js"
import { ComponentEvaluationContext, type ApplicationSpanRunner } from "./component-evaluation-context.js"
import { AmlEventBus } from "./aml-event-bus.js"
import type { AmlEventListener, AmlEventName } from "./aml-event-subscriber.js"
import { EvaluationContext } from "./evaluation-context.js"
import { EvaluationError } from "./evaluation-error.js"
import type { AmlTraceIdentity } from "./trace-identity.js"
import type { TraceSpan } from "../observability/trace-dispatcher.js"
import type { TraceErrorHandler, TraceSink } from "../observability/trace-sink.js"

// Resolution targets keep prompt assembly separate from ordinary text output.
// That distinction lets descriptors such as <Tool> and <System> mutate only the
// nearest Agent plan while ordinary values preserve their authored position.
interface TextTarget {
  readonly chunks: string[]
  readonly contextScope: ContextScope
  readonly kind: "text"
  readonly parentSpanId: string | undefined
  readonly sandbox: Readonly<SandboxSession> | undefined
  readonly source: "evaluation" | "file" | "follow-up" | "script" | "skill" | "system"
  readonly runtimeTool?: AgentJavaScriptTool
  readonly structured: StructuredEvaluation | undefined
  readonly workspace: Readonly<WorkspaceMaterializationReference> | undefined
}

interface AgentTarget {
  readonly acceptsMessageDescriptors: boolean
  readonly contextScope: ContextScope
  readonly followUps: string[]
  readonly kind: "agent"
  readonly mcpServers: McpCollection
  readonly parentSpanId: string
  readonly promptChunks: string[]
  readonly sandbox: Readonly<SandboxSession> | undefined
  readonly structured: StructuredEvaluation | undefined
  readonly systemFragments: string[]
  readonly tools: ToolCollection
  readonly workspace: Readonly<WorkspaceMaterializationReference> | undefined
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
 * Lexical Context and resource state inherited by component-local evaluation.
 */
interface EvaluationScope {
  readonly contextScope: ContextScope
  readonly depth: number
  readonly parentSpanId: string | undefined
  readonly sandbox: Readonly<SandboxSession> | undefined
  readonly workspace: Readonly<WorkspaceMaterializationReference> | undefined
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
  readonly collectStructured: boolean
  readonly kind: "complete-agent"
  readonly plan: AgentTarget
  readonly props: Readonly<AgentProps>
  readonly provider: Readonly<ValidatedAgentProvider> | undefined
  readonly schema: ModelSchema<unknown> | undefined
  readonly sandbox: Readonly<SandboxSession> | undefined
  readonly span: TraceSpan
  readonly target: ResolutionTarget
  readonly trace: AmlTraceIdentity
}

interface CompleteFollowUpFrame {
  readonly kind: "complete-follow-up"
  readonly parent: AgentTarget
  readonly target: TextTarget
}

interface CompleteFileFrame {
  readonly plan: Readonly<FileEvaluation>
  readonly kind: "complete-file"
  readonly span: TraceSpan
  readonly text: TextTarget
}

interface CompleteSandboxFrame {
  readonly kind: "complete-sandbox"
  readonly scope: Readonly<SandboxEvaluationScope>
  readonly span: TraceSpan
}

interface CompleteScriptFrame {
  readonly kind: "complete-script"
  readonly plan: Readonly<ScriptEvaluation>
  readonly span: TraceSpan
  readonly target: ResolutionTarget
  readonly text: TextTarget
}

interface CompleteWorkspaceFrame {
  readonly kind: "complete-workspace"
  readonly scope: Readonly<WorkspaceEvaluationScope>
  readonly span: TraceSpan
}

interface CompleteSystemFrame {
  readonly kind: "complete-system"
  readonly parent: AgentTarget
  readonly span: TraceSpan
  readonly target: TextTarget
}

interface CompleteSkillFrame {
  readonly kind: "complete-skill"
  readonly plan: SkillEvaluation
  readonly span: TraceSpan
  readonly target: ResolutionTarget
  readonly text: TextTarget
}

interface CompleteComponentFrame {
  readonly kind: "complete-component"
  readonly span: TraceSpan
}

type EvaluationFrame =
  | ArrayFrame
  | CompleteAgentFrame
  | CompleteComponentFrame
  | CompleteFileFrame
  | CompleteFollowUpFrame
  | CompleteSandboxFrame
  | CompleteScriptFrame
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
   * Exact MCP server names that authored `<Mcp>` components may grant.
   *
   * Omit this option to allow every otherwise valid server. An empty array
   * denies all authored MCP servers. Names must be non-empty, already-trimmed
   * strings and are matched case-sensitively.
   */
  readonly allowedMcpServers?: readonly string[]

  /**
   * Exact JavaScript tool names that authored `<Tool>` components may grant.
   *
   * Omit this option to allow every otherwise valid tool. An empty array
   * denies all authored tools. Names must be non-empty, already-trimmed
   * strings and are matched case-sensitively. Runtime-owned capabilities,
   * such as Loop state, are not filtered by this authoring allowlist.
   */
  readonly allowedTools?: readonly string[]

  /**
   * Provider used by each `<Agent>` that does not set its own `provider` prop.
   *
   * No provider is configured by default. Evaluating an Agent without either
   * source of provider then throws an {@link EvaluationError}.
   */
  readonly agentProvider?: AgentProvider

  /**
   * Host directory used to resolve relative `<Skill src>` paths and as the
   * default working directory for host-executed `<Script>` components.
   *
   * Defaults to `process.cwd()` when the runtime is constructed. An active
   * Sandbox supplies its effective cwd to nested Scripts instead. A Workspace
   * affects Script cwd only when it supplies the default cwd of an enclosing
   * Sandbox.
   */
  readonly cwd?: string

  /**
   * Maximum number of provider-backed Agent sessions in one evaluation.
   *
   * Defaults to `32`. Use `0` to disable this limit. The value must be a
   * non-negative safe integer and includes Agent calls made by nested
   * component-local `evaluate()` operations.
   */
  readonly maxAgentCalls?: number

  /**
   * Maximum number of Agent provider calls that may be active concurrently in
   * one evaluation.
   *
   * Defaults to `4`. Use `0` to disable this limit. The value must be a
   * non-negative safe integer. Calls beyond the limit wait for capacity rather
   * than failing solely because the limit is occupied.
   */
  readonly maxConcurrentAgents?: number

  /**
   * Maximum semantic nesting depth of JSX nodes in one evaluation.
   *
   * Defaults to `16`. Use `0` to disable this limit. The value must be a
   * non-negative safe integer. Arrays and Promises do not add semantic depth;
   * Fragments and components do.
   */
  readonly maxDepth?: number

  /**
   * Maximum committed state transitions across all `<Loop>` components in one
   * evaluation.
   *
   * Defaults to `16`. Use `0` to disable this limit. The value must be a
   * non-negative safe integer.
   */
  readonly maxStateTransitions?: number

  /**
   * Maximum authored inputs sent during one Agent provider session.
   *
   * Defaults to `16`. Use `0` to disable this limit. The value must be a
   * non-negative safe integer. The initial prompt and each `<FollowUp>` count
   * as turns; provider tool-call traffic does not consume authored turns.
   */
  readonly maxTurnsPerAgent?: number

  /**
   * Handles exceptions and rejected promises produced by trace listeners.
   *
   * Trace observation never changes workflow success. When omitted, listener
   * failures are ignored. The handler receives the error and the redacted event
   * that was being observed.
   */
  readonly onTraceError?: TraceErrorHandler

  /**
   * Provider used by an outer `<Sandbox>` that does not set its own `provider`.
   *
   * No Sandbox provider is configured by default. Nested Sandboxes inherit the
   * active lease and cannot switch providers.
   */
  readonly sandboxProvider?: SandboxProvider

  /**
   * Runtime-wide system instruction prepended to every Agent request.
   *
   * Defaults to no runtime instruction. This fragment precedes the Agent's
   * `system` prop and nested `<System>` fragments in deterministic order.
   */
  readonly system?: string

  /**
   * Listener that receives immutable trace events from every evaluation run by
   * this runtime.
   *
   * Omitted by default. Trace delivery is observational and is not awaited by
   * workflow execution. Content is redacted unless the sink explicitly opts in
   * through the {@link TraceSink} contract.
   */
  readonly trace?: TraceSink

  /**
   * Provider used by the single top-level `<Workspace>` in an evaluation when
   * that component does not set its own `provider`.
   *
   * No Workspace provider is configured by default. Nested Workspaces are not
   * supported because one evaluation owns at most one durable materialization.
   */
  readonly workspaceProvider?: WorkspaceProvider
}

/**
 * Per-call controls that must not leak between concurrent evaluations.
 */
export interface AmlEvaluationOptions {
  /**
   * Caller-owned cancellation signal for this complete evaluation.
   *
   * When omitted, the runtime creates a never-aborted signal for the call.
   * Cancellation is propagated to providers and resource cleanup. If already
   * aborted, `evaluate()` rejects before starting the AML tree.
   */
  readonly signal?: AbortSignal
}

/**
 * Evaluates authored AML trees with captured providers, policy, limits, and
 * runtime-wide event listeners.
 *
 * A runtime is reusable and supports concurrent `evaluate()` calls. Each call
 * owns its cancellation, budgets, Context state, resources, and trace identity;
 * only the immutable constructor configuration and registered listeners are
 * shared.
 */
export class AmlRuntime {
  readonly #agentExecutor: AgentExecutor
  readonly #allowedMcpServers: ReadonlySet<string> | undefined
  readonly #allowedTools: ReadonlySet<string> | undefined
  readonly #events = new AmlEventBus()
  readonly #fileEvaluator = new FileEvaluator()
  readonly #maxAgentCalls: number
  readonly #maxConcurrentAgents: number
  readonly #maxDepth: number
  readonly #maxStateTransitions: number
  readonly #onTraceError: TraceErrorHandler | undefined
  readonly #loopAgentSelector: LoopAgentSelector
  readonly #loopEvaluator = new LoopEvaluator()
  readonly #sandboxEvaluator: SandboxEvaluator
  readonly #scriptEvaluator: ScriptEvaluator
  readonly #skillEvaluator: SkillEvaluator
  readonly #workspaceEvaluator: WorkspaceEvaluator

  /**
   * Captures one immutable set of provider defaults, capability policy, safety
   * limits, and trace configuration.
   *
   * Mutable option arrays are copied during construction. Invalid numeric
   * limits, capability names, or callback values throw synchronously.
   */
  constructor(options: AmlRuntimeOptions = {}) {
    const maxAgentCalls = options.maxAgentCalls ?? 32
    const maxConcurrentAgents = options.maxConcurrentAgents ?? 4
    const maxDepth = options.maxDepth ?? 16
    const maxStateTransitions = options.maxStateTransitions ?? 16
    const maxTurnsPerAgent = options.maxTurnsPerAgent ?? 16
    const trace = captureTraceOptions(options.trace, options.onTraceError)

    if (!Number.isSafeInteger(maxAgentCalls) || maxAgentCalls < 0) {
      throw new TypeError("maxAgentCalls must be a non-negative safe integer")
    }

    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
      throw new TypeError("maxDepth must be a non-negative safe integer")
    }

    if (!Number.isSafeInteger(maxConcurrentAgents) || maxConcurrentAgents < 0) {
      throw new TypeError("maxConcurrentAgents must be a non-negative safe integer")
    }

    if (!Number.isSafeInteger(maxTurnsPerAgent) || maxTurnsPerAgent < 0) {
      throw new TypeError("maxTurnsPerAgent must be a non-negative safe integer")
    }

    if (!Number.isSafeInteger(maxStateTransitions) || maxStateTransitions < 0) {
      throw new TypeError("maxStateTransitions must be a non-negative safe integer")
    }

    this.#allowedMcpServers = captureAllowedNames(options.allowedMcpServers, "allowedMcpServers")
    this.#allowedTools = captureAllowedNames(options.allowedTools, "allowedTools")
    this.#agentExecutor = new AgentExecutor({
      ...(options.agentProvider === undefined ? {} : { agentProvider: options.agentProvider }),
      maxTurnsPerAgent,
      ...(options.system === undefined ? {} : { system: options.system }),
    })
    this.#maxAgentCalls = maxAgentCalls
    this.#maxConcurrentAgents = maxConcurrentAgents
    this.#maxDepth = maxDepth
    this.#maxStateTransitions = maxStateTransitions
    this.#onTraceError = trace.onError

    if (trace.sink !== undefined) {
      this.#events.on("trace", trace.sink)
    }
    this.#loopAgentSelector = new LoopAgentSelector(maxDepth)
    this.#sandboxEvaluator = new SandboxEvaluator(options.sandboxProvider)
    const cwd = options.cwd ?? process.cwd()
    this.#scriptEvaluator = new ScriptEvaluator(cwd)
    this.#skillEvaluator = new SkillEvaluator(cwd)
    this.#workspaceEvaluator = new WorkspaceEvaluator(options.workspaceProvider)
  }

  /**
   * Registers a listener for each matching event emitted by this runtime.
   *
   * `start` and `finish` listeners are awaited at their lifecycle boundaries;
   * `trace` listeners are observational and are not awaited. The returned
   * function unregisters this exact listener and is safe to call repeatedly.
   */
  on<Name extends AmlEventName>(name: Name, listener: AmlEventListener<Name>): () => void {
    return this.#events.on(name, listener)
  }

  /**
   * Registers a listener for the next matching event emitted by this runtime.
   *
   * The listener unregisters before it is invoked, so recursive or concurrent
   * event delivery cannot invoke it twice. The returned function may be used to
   * cancel the registration before that event occurs.
   */
  once<Name extends AmlEventName>(name: Name, listener: AmlEventListener<Name>): () => void {
    return this.#events.once(name, listener)
  }

  /**
   * Resolves one AML tree to its final string output.
   *
   * Empty values contribute no text, arrays preserve authored order, and
   * numbers are stringified. Components and promises are resolved
   * asynchronously. The returned promise rejects on invalid AML, provider or
   * resource failures, exhausted limits, cycles, or cancellation. Cleanup is
   * attempted before the promise settles.
   */
  async evaluate(value: AmlRenderable, options: AmlEvaluationOptions = {}): Promise<string> {
    const signal = options.signal ?? new AbortController().signal
    signal.throwIfAborted()

    // Each evaluation owns cancellation, limits, trace allocation, and cycle
    // tracking. No mutable execution state is shared between calls.
    const domain: EvaluationDomain = {
      context: new EvaluationContext(
        this.#maxAgentCalls,
        this.#maxConcurrentAgents,
        this.#maxStateTransitions,
        signal,
        this.#events,
        {
          onError: this.#onTraceError,
        }
      ),
      workspaceDeclared: false,
    }

    let evaluationError: unknown
    let evaluationFailed = false

    try {
      await domain.context.start()

      return (await this.#evaluateInDomain(
        value,
        domain,
        {
          contextScope: ContextScope.empty,
          depth: 0,
          parentSpanId: domain.context.rootTrace.spanId,
          sandbox: undefined,
          workspace: undefined,
        },
        undefined
      )) as string
    } catch (error) {
      evaluationFailed = true
      evaluationError = error
      throw error
    } finally {
      await domain.context.close(evaluationFailed, evaluationError)
    }
  }

  /**
   * Resolves one root or component-local subtree inside an existing domain.
   *
   * Each invocation owns resources it acquires, but inherits the caller's
   * lexical Context, Sandbox, Workspace, depth, trace parent, budgets, and
   * cancellation.
   */
  async #evaluateInDomain(
    value: AmlRenderable,
    domain: EvaluationDomain,
    scope: EvaluationScope,
    schema: ModelSchema<unknown> | undefined,
    activeAncestors: ReadonlySet<object> = new Set(),
    runtimeTool?: AgentJavaScriptTool
  ): Promise<unknown> {
    const context = domain.context
    // Component-local evaluate() starts a new frame stack, but it remains on
    // the caller's logical branch. Copying its ancestry preserves cycle
    // detection while keeping concurrent nested calls independent.
    const activeValues = new Set(activeAncestors)
    const activeSandboxScopes: SandboxEvaluationScope[] = []
    const activeTraceSpans: TraceSpan[] = []
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
      contextScope: scope.contextScope,
      kind: "text",
      parentSpanId: scope.parentSpanId,
      sandbox: scope.sandbox,
      source: "evaluation",
      structured,
      workspace: scope.workspace,
      ...(runtimeTool === undefined ? {} : { runtimeTool }),
    }
    const frames: EvaluationFrame[] = [{ depth: scope.depth, kind: "resolve", target: output, value }]

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

        if (frame.kind === "complete-component") {
          removeActiveTraceSpan(activeTraceSpans, frame.span)
          context.endTraceSpan(frame.span, "ok")
          continue
        }

        if (frame.kind === "complete-sandbox") {
          removeActiveTraceSpan(activeTraceSpans, frame.span)

          if (frame.scope.ownsLease) {
            // Remove ownership before awaiting release. A release failure must
            // not make the outer cleanup path invoke the provider twice.
            const scope = activeSandboxScopes.pop()

            if (scope !== frame.scope) {
              const error = new EvaluationError("Sandbox scopes completed out of lifecycle order")
              context.failTraceSpan(frame.span, error)
              throw error
            }
          }

          try {
            await frame.scope.release()
          } catch (releaseError) {
            context.failTraceSpan(frame.span, releaseError)

            // Cancellation can arrive after this frame removes ownership but
            // while provider cleanup is pending. Preserve both causes instead
            // of letting the later release failure mask caller control flow.
            if (context.signal.aborted) {
              throw new AggregateError(
                [context.signal.reason, releaseError],
                "AML evaluation was cancelled and Sandbox cleanup failed"
              )
            }

            throw releaseError
          }

          if (context.signal.aborted) {
            const cancellation = context.signal.reason
            context.failTraceSpan(frame.span, cancellation)
            context.signal.throwIfAborted()
          }

          context.endTraceSpan(frame.span, "ok")
          continue
        }

        if (frame.kind === "complete-workspace") {
          removeActiveTraceSpan(activeTraceSpans, frame.span)

          if (activeWorkspaceScope !== frame.scope) {
            const error = new EvaluationError("Workspace scopes completed out of lifecycle order")
            context.failTraceSpan(frame.span, error)
            throw error
          }

          // Remove ownership before completion so a save or release failure is
          // never retried by the outer cleanup path.
          activeWorkspaceScope = undefined

          try {
            await frame.scope.complete("success")
          } catch (completionError) {
            context.failTraceSpan(frame.span, completionError)

            if (context.signal.aborted) {
              throw new AggregateError(
                [context.signal.reason, completionError],
                "AML evaluation was cancelled and Workspace completion failed"
              )
            }

            throw completionError
          }

          if (context.signal.aborted) {
            const cancellation = context.signal.reason
            context.failTraceSpan(frame.span, cancellation)
            context.signal.throwIfAborted()
          }

          context.endTraceSpan(frame.span, "ok")
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
          let text: string

          try {
            text = frame.target.chunks.join("").trim()

            if (text.length === 0) {
              throw new EvaluationError("<System> must resolve to non-empty text")
            }

            frame.parent.systemFragments.push(text)
          } catch (error) {
            removeActiveTraceSpan(activeTraceSpans, frame.span)
            context.failTraceSpan(frame.span, error)
            throw error
          }

          removeActiveTraceSpan(activeTraceSpans, frame.span)
          context.endTraceSpan(frame.span, "ok", {}, { content: text })
          continue
        }

        if (frame.kind === "complete-follow-up") {
          const text = frame.target.chunks.join("").trim()

          if (text.length === 0) {
            throw new EvaluationError("<FollowUp> must resolve to non-empty text")
          }

          frame.parent.followUps.push(text)
          continue
        }

        if (frame.kind === "complete-file") {
          try {
            await this.#fileEvaluator.complete(frame.plan, frame.text.chunks.join(""), context.signal)
          } catch (error) {
            removeActiveTraceSpan(activeTraceSpans, frame.span)
            context.failTraceSpan(frame.span, error)
            throw error
          }

          removeActiveTraceSpan(activeTraceSpans, frame.span)
          context.endTraceSpan(frame.span, "ok", { path: frame.plan.path })
          continue
        }

        if (frame.kind === "complete-skill") {
          let content: string

          try {
            content = await this.#skillEvaluator.complete(frame.plan, frame.text.chunks.join(""), context.signal)
            appendText(frame.target, content)
          } catch (error) {
            removeActiveTraceSpan(activeTraceSpans, frame.span)
            context.failTraceSpan(frame.span, error)
            throw error
          }

          removeActiveTraceSpan(activeTraceSpans, frame.span)
          context.endTraceSpan(frame.span, "ok", {}, { content })
          continue
        }

        if (frame.kind === "complete-script") {
          let result: Readonly<{ exitCode: number; stderr: string; stdout: string }>

          try {
            result = await this.#scriptEvaluator.complete(frame.plan, frame.text.chunks.join(""), context.signal)
            appendText(frame.target, result.stdout)
          } catch (error) {
            removeActiveTraceSpan(activeTraceSpans, frame.span)
            context.failTraceSpan(frame.span, error)
            throw error
          }

          removeActiveTraceSpan(activeTraceSpans, frame.span)
          context.endTraceSpan(frame.span, "ok", {
            exitCode: result.exitCode,
            stderrLength: result.stderr.length,
            stdoutLength: result.stdout.length,
          })
          continue
        }

        if (frame.kind === "complete-agent") {
          // A completion frame runs only after every child has contributed text,
          // System fragments, Tool descriptors, or MCP grants to the Agent plan.
          const execution = await this.#agentExecutor.execute({
            context,
            followUps: frame.plan.followUps,
            mcpServers: frame.plan.mcpServers.values(),
            ...(frame.schema === undefined ? {} : { output: frame.schema }),
            prompt: frame.plan.promptChunks.join(""),
            provider: frame.provider,
            props: frame.props,
            sandbox: frame.sandbox,
            systemFragments: frame.plan.systemFragments,
            tools: frame.plan.tools.values(),
            trace: frame.trace,
          })
          const response = execution.response

          if (frame.schema !== undefined && frame.collectStructured) {
            const collector = frame.target.structured

            if (collector === undefined) {
              throw new EvaluationError("Structured Agent completed without an evaluation collector")
            }

            // AgentExecutor requires and validates this field whenever it
            // receives a ModelSchema, including transformed undefined output.
            collector.hasResult = true
            collector.result = response.structured
          } else if (frame.schema !== undefined) {
            appendText(frame.target, frame.schema.stringify(response.structured))
          } else {
            appendText(frame.target, response.text)
          }

          // Runtime owns the terminal span because successful provider output
          // is not complete until it has entered the parent AML result channel.
          removeActiveTraceSpan(activeTraceSpans, frame.span)
          context.endTraceSpan(frame.span, "ok", execution.traceAttributes, execution.traceContent)
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

        if (current === null || current === undefined || typeof current === "boolean") {
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
            throw new EvaluationError(`AML evaluation exceeded maxDepth ${this.#maxDepth}`)
          }

          if (activeValues.has(current)) {
            throw new EvaluationError("AML nodes cannot contain cycles")
          }

          if (typeof current.type !== "function") {
            throw new EvaluationError("AML does not support intrinsic or unknown JSX element types")
          }

          const primitiveKind = AmlNode.primitiveKind(current.type)

          // <Agent> creates a new capability and prompt scope. Its completion is
          // deliberately scheduled before its children on the LIFO stack.
          if (primitiveKind === "agent") {
            const collector = frame.target.structured

            if (collector !== undefined) {
              collector.agentCount += 1

              if (collector.agentCount > 1) {
                throw new EvaluationError("Structured evaluate() must resolve to exactly one <Agent>")
              }
            }

            const props = current.props as Readonly<AgentProps>
            const trace = context.createTrace(frame.target.parentSpanId)
            const span = context.startTraceSpan(trace, "agent", "Agent")
            let provider: Readonly<ValidatedAgentProvider> | undefined
            let schema: ModelSchema<unknown> | undefined
            let sandbox: Readonly<SandboxSession> | undefined

            try {
              provider = this.#agentExecutor.validateProps(props)
              const evaluationSchema =
                collector !== undefined && frame.target.kind === "text" && frame.target.source === "evaluation"
                  ? collector.schema
                  : undefined
              schema = this.#agentExecutor.outputSchema(props, evaluationSchema)
              sandbox = this.#sandboxEvaluator.forAgent(frame.target.sandbox, props.cwd)
            } catch (error) {
              context.failTraceSpan(span, error)
              throw error
            }

            const plan: AgentTarget = {
              acceptsMessageDescriptors: true,
              contextScope: frame.target.contextScope,
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

            if (frame.target.kind === "text" && frame.target.runtimeTool !== undefined) {
              plan.tools.addRuntime(frame.target.runtimeTool)
            }

            // Push completion before children: the LIFO stack gives AML its
            // bottom-up execution semantics without suspending a component.
            activeValues.add(current)
            activeTraceSpans.push(span)
            frames.push({ kind: "release", value: current })
            frames.push({
              collectStructured:
                collector !== undefined && frame.target.kind === "text" && frame.target.source === "evaluation",
              kind: "complete-agent",
              plan,
              props,
              provider,
              schema,
              sandbox,
              span,
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

          // Context Provider is a transparent lexical wrapper. It changes only
          // the binding map inherited by descendants and preserves the current
          // text or Agent descriptor channel exactly.
          if (primitiveKind === "context") {
            const binding = ContextRegistry.captureProvider(current.type, current.props)
            const scopedTarget: ResolutionTarget = {
              ...frame.target,
              contextScope: frame.target.contextScope.provide(binding.definition, binding.value),
            }

            activeValues.add(current)
            frames.push({ kind: "release", value: current })
            frames.push({
              depth: nodeDepth,
              kind: "resolve",
              target: scopedTarget,
              value: binding.children,
            })
            continue
          }

          // <Loop> owns repeated fresh Agent sessions and one staged state
          // capability. Its render callback is selected to one outer Agent
          // before any of that Agent's descendants execute.
          if (primitiveKind === "loop") {
            if (frame.target.structured !== undefined) {
              // Structured evaluate() permits one provider call total. The
              // collector follows the root Agent into its prompt, System, and
              // FollowUp targets, so a Loop in any of those channels would
              // otherwise start hidden sessions outside that contract.
              throw new EvaluationError("Structured evaluate() must resolve to exactly one <Agent>")
            }

            const props = current.props as Readonly<LoopProps<StandardSchemaV1<unknown, Record<string, unknown>>>>
            const trace = context.createTrace(frame.target.parentSpanId)
            const span = context.startTraceSpan(trace, "loop", "Loop")

            activeValues.add(current)
            let result: string

            try {
              result = await this.#loopEvaluator.evaluate(props, context, span.identity, async (value, stateTool) => {
                const selection = await this.#loopAgentSelector.select(
                  value,
                  nodeDepth,
                  new Set(activeValues),
                  frame.target.contextScope,
                  context.signal,
                  async (componentType, component, evaluateNested, contextScope) => {
                    const componentTrace = context.createObservationTrace(trace.spanId)
                    const componentSpan = context.startTraceSpan(
                      componentTrace,
                      "component",
                      traceComponentName(componentType)
                    )

                    try {
                      const output = await ComponentEvaluationContext.invoke(
                        component,
                        evaluateNested,
                        contextScope,
                        (tool, input) => this.#callTool(tool, input, context, componentTrace),
                        componentTrace.spanId,
                        this.#applicationSpanRunner(context, componentTrace.spanId)
                      )
                      context.endTraceSpan(componentSpan, "ok")
                      return output
                    } catch (error) {
                      context.failTraceSpan(componentSpan, error)
                      throw error
                    }
                  },
                  async (nestedValue, nestedSchema, nestedDepth, nestedAncestors, nestedContextScope, parentSpanId) => {
                    const modelSchema = nestedSchema === undefined ? undefined : new ModelSchema(nestedSchema)

                    return await this.#evaluateInDomain(
                      nestedValue,
                      domain,
                      {
                        contextScope: nestedContextScope,
                        depth: nestedDepth,
                        parentSpanId,
                        sandbox: frame.target.sandbox,
                        workspace: frame.target.workspace,
                      },
                      modelSchema,
                      nestedAncestors
                    )
                  }
                )

                return (await this.#evaluateInDomain(
                  selection.agent,
                  domain,
                  {
                    contextScope: selection.contextScope,
                    depth: selection.parentDepth,
                    parentSpanId: trace.spanId,
                    sandbox: frame.target.sandbox,
                    workspace: frame.target.workspace,
                  },
                  undefined,
                  selection.activeAncestors,
                  stateTool
                )) as string
              })
              context.endTraceSpan(span, "ok")
            } catch (error) {
              context.failTraceSpan(span, error)
              throw error
            } finally {
              activeValues.delete(current)
            }

            appendText(frame.target, result)
            continue
          }

          // <FollowUp> redirects its children into one later user-message
          // channel while the containing Agent still resolves post-order.
          if (primitiveKind === "follow-up") {
            if (frame.target.kind !== "agent" || !frame.target.acceptsMessageDescriptors) {
              const placement =
                frame.target.kind === "text" && frame.target.source === "follow-up"
                  ? "nested <FollowUp> descriptors are invalid"
                  : frame.target.kind === "agent"
                    ? "<FollowUp> must be an immediate message descriptor of <Agent>"
                    : "<FollowUp> is only valid inside <Agent>"
              throw new EvaluationError(placement)
            }

            const props = current.props as Readonly<FollowUpProps>
            const followUpTarget: TextTarget = {
              chunks: [],
              contextScope: frame.target.contextScope,
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
            const span = context.startTraceSpan(trace, "sandbox", "Sandbox", {
              nested: frame.target.sandbox !== undefined,
            })
            let scope: Readonly<SandboxEvaluationScope>

            try {
              scope = await this.#sandboxEvaluator.enter(
                props,
                frame.target.sandbox,
                frame.target.workspace,
                trace.runId,
                context.signal
              )
            } catch (error) {
              context.failTraceSpan(span, error)
              throw error
            }

            const scopedTarget: ResolutionTarget = {
              ...frame.target,
              // A lexical resource primitive remains visible after component
              // expansion, so descriptors beneath it are not immediate Agent
              // messages. A nested Agent creates its own direct message scope.
              ...(frame.target.kind === "agent" ? { acceptsMessageDescriptors: false } : {}),
              parentSpanId: trace.spanId,
              sandbox: scope.session,
            }

            activeValues.add(current)
            activeTraceSpans.push(span)
            frames.push({ kind: "release", value: current })

            if (scope.ownsLease) {
              // Root scopes are tracked separately so cancellation or any
              // descendant failure still reaches provider cleanup.
              activeSandboxScopes.push(scope)
            }

            frames.push({ kind: "complete-sandbox", scope, span })
            frames.push({
              depth: nodeDepth,
              kind: "resolve",
              target: scopedTarget,
              value: props.children,
            })
            continue
          }

          // <File> consumes resolved child text as a Workspace side effect. The
          // content does not also leak into its surrounding prompt or result.
          if (primitiveKind === "file") {
            const props = current.props as Readonly<FileProps>
            const plan = this.#fileEvaluator.prepare(props, frame.target.workspace, frame.target.sandbox)
            const trace = context.createTrace(frame.target.parentSpanId)
            const span = context.startTraceSpan(trace, "file", "File", { path: plan.path })
            const fileTarget: TextTarget = {
              chunks: [],
              contextScope: frame.target.contextScope,
              kind: "text",
              parentSpanId: trace.spanId,
              sandbox: frame.target.sandbox,
              source: "file",
              structured: frame.target.structured,
              workspace: frame.target.workspace,
            }

            activeValues.add(current)
            activeTraceSpans.push(span)
            frames.push({ kind: "release", value: current })
            frames.push({
              kind: "complete-file",
              plan,
              span,
              text: fileTarget,
            })
            frames.push({
              depth: nodeDepth,
              kind: "resolve",
              target: fileTarget,
              value: props.children,
            })
            continue
          }

          // <Script> resolves dynamic child text before selecting the host or
          // active Sandbox runtime captured in its execution plan.
          if (primitiveKind === "script") {
            const props = current.props as Readonly<ScriptProps>
            const plan = this.#scriptEvaluator.prepare(props, frame.target.sandbox)
            const trace = context.createTrace(frame.target.parentSpanId)
            const span = context.startTraceSpan(trace, "script", "Script", {
              environment: plan.sandbox === undefined ? "host" : "sandbox",
              mode: plan.kind,
              ...(plan.kind === "command" ? { command: plan.command } : { shell: plan.shell }),
            })
            const scriptTarget: TextTarget = {
              chunks: [],
              contextScope: frame.target.contextScope,
              kind: "text",
              parentSpanId: trace.spanId,
              sandbox: frame.target.sandbox,
              source: "script",
              structured: frame.target.structured,
              workspace: frame.target.workspace,
            }

            activeValues.add(current)
            activeTraceSpans.push(span)
            frames.push({ kind: "release", value: current })
            frames.push({
              kind: "complete-script",
              plan,
              span,
              target: frame.target,
              text: scriptTarget,
            })

            if (props.children !== undefined) {
              frames.push({
                depth: nodeDepth,
                kind: "resolve",
                target: scriptTarget,
                value: props.children,
              })
            }

            continue
          }

          // <Workspace> is the one top-level durable resource boundary. It
          // cannot hide inside prompt assembly or another resource scope.
          if (primitiveKind === "workspace") {
            if (domain.workspaceDeclared) {
              throw new EvaluationError("An AML evaluation may contain at most one <Workspace>")
            }

            if (
              frame.target.kind !== "text" ||
              frame.target.source !== "evaluation" ||
              frame.target.sandbox !== undefined ||
              frame.target.workspace !== undefined
            ) {
              throw new EvaluationError("<Workspace> must be a top-level resource boundary")
            }

            domain.workspaceDeclared = true
            const props = current.props as Readonly<WorkspaceProps>
            const trace = context.createTrace(frame.target.parentSpanId)
            const span = context.startTraceSpan(trace, "workspace", "Workspace")
            let scope: Readonly<WorkspaceEvaluationScope>

            try {
              scope = await this.#workspaceEvaluator.enter(props, trace.runId, context.signal)
            } catch (error) {
              context.failTraceSpan(span, error)
              throw error
            }

            const scopedTarget: TextTarget = {
              ...frame.target,
              parentSpanId: trace.spanId,
              workspace: scope.materialization,
            }

            activeWorkspaceScope = scope
            activeValues.add(current)
            activeTraceSpans.push(span)
            frames.push({ kind: "release", value: current })
            frames.push({
              kind: "complete-workspace",
              scope,
              span,
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
                throw new EvaluationError("<Mcp> is invalid inside <FollowUp>")
              }

              throw new EvaluationError("<Mcp> is only valid inside <Agent>")
            }

            // MCP descriptors mutate only the nearest Agent plan. Providers
            // perform attachment later at the complete-session boundary.
            frame.target.mcpServers.add(current.props as Readonly<McpProps>)
            continue
          }

          // <Tool> is metadata for the nearest Agent, not prompt text.
          if (primitiveKind === "tool") {
            if (frame.target.kind !== "agent") {
              if (frame.target.source === "follow-up") {
                throw new EvaluationError("<Tool> is invalid inside <FollowUp>")
              }

              throw new EvaluationError("<Tool> is only valid inside <Agent>")
            }

            // Tool descriptors mutate only the nearest Agent plan and never add
            // text to its initial prompt.
            frame.target.tools.add(current.props as Readonly<ToolProps>)
            continue
          }

          // Skills combine an optional local file with post-order child text.
          // They remain prompt text rather than a provider-specific capability.
          if (primitiveKind === "skill") {
            const plan = this.#skillEvaluator.prepare(current.props)
            const trace = context.createObservationTrace(frame.target.parentSpanId)
            const span = context.startTraceSpan(
              trace,
              "skill",
              plan.name ?? "Skill",
              {
                hasInlineContent: plan.hasChildren,
                hasSource: plan.source !== undefined,
              },
              {
                ...(plan.description === undefined ? {} : { description: plan.description }),
                ...(plan.source === undefined ? {} : { source: plan.source }),
              }
            )

            const skillTarget: TextTarget = {
              chunks: [],
              contextScope: frame.target.contextScope,
              kind: "text",
              parentSpanId: trace.spanId,
              sandbox: frame.target.sandbox,
              source: "skill",
              structured: frame.target.structured,
              workspace: frame.target.workspace,
            }

            activeValues.add(current)
            activeTraceSpans.push(span)
            frames.push({ kind: "release", value: current })
            frames.push({
              kind: "complete-skill",
              plan,
              span,
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
            const trace = context.createObservationTrace(frame.target.parentSpanId)
            const span = context.startTraceSpan(trace, "system", "System", {
              index: frame.target.systemFragments.length + 1,
            })
            const systemTarget: TextTarget = {
              chunks: [],
              contextScope: frame.target.contextScope,
              kind: "text",
              parentSpanId: trace.spanId,
              sandbox: frame.target.sandbox,
              source: "system",
              structured: frame.target.structured,
              workspace: frame.target.workspace,
            }

            activeValues.add(current)
            activeTraceSpans.push(span)
            frames.push({ kind: "release", value: current })
            frames.push({
              kind: "complete-system",
              parent: frame.target,
              span,
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
          const trace = context.createObservationTrace(frame.target.parentSpanId)
          const span = context.startTraceSpan(trace, "component", traceComponentName(current.type))
          activeValues.add(current)
          frames.push({ kind: "release", value: current })
          let componentOutput: unknown

          try {
            componentOutput = await ComponentEvaluationContext.invoke(
              () => current.type(current.props),
              async (nestedValue, nestedSchema, parentSpanId) => {
                context.signal.throwIfAborted()

                // A nested schema is captured before its provider boundary.
                // Both calls remain in this domain and inherit only lexical
                // execution resources, never the parent Agent's capabilities.
                const modelSchema = nestedSchema === undefined ? undefined : new ModelSchema(nestedSchema)

                return await this.#evaluateInDomain(
                  nestedValue,
                  domain,
                  {
                    contextScope: frame.target.contextScope,
                    depth: nodeDepth,
                    parentSpanId,
                    sandbox: frame.target.sandbox,
                    workspace: frame.target.workspace,
                  },
                  modelSchema,
                  new Set(activeValues)
                )
              },
              frame.target.contextScope,
              (tool, input) => this.#callTool(tool, input, context, trace),
              trace.spanId,
              this.#applicationSpanRunner(context, trace.spanId)
            )
          } catch (error) {
            context.failTraceSpan(span, error)
            throw error
          }

          activeTraceSpans.push(span)
          context.signal.throwIfAborted()
          frames.push({ kind: "complete-component", span })
          frames.push({
            depth: nodeDepth,
            kind: "resolve",
            target: {
              ...frame.target,
              parentSpanId: trace.spanId,
            },
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
        throw new EvaluationError(`AML cannot render a value of type ${typeof current}`)
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
          await scope.complete("failure")
        } catch (completionError) {
          releaseErrors.push(completionError)
        }
      }

      const terminalError =
        releaseErrors.length > 0
          ? new AggregateError([error, ...releaseErrors], "AML evaluation and resource cleanup both failed")
          : error

      // Spans still on this invocation's stack represent boundaries skipped by
      // failure unwinding. End them only after resource cleanup so Sandbox and
      // Workspace durations include their failure-safe release work.
      while (activeTraceSpans.length > 0) {
        const span = activeTraceSpans.pop()

        if (span === undefined) {
          break
        }

        context.failTraceSpan(span, terminalError)
      }

      throw terminalError
    }

    if (structured !== undefined) {
      if (structured.agentCount !== 1 || !structured.hasResult) {
        throw new EvaluationError("Structured evaluate() must resolve to exactly one <Agent>")
      }

      return structured.result
    }

    return output.chunks.join("")
  }
  /**
   * Executes application-invoked Tools through the registered SDK port and the
   * same validation, snapshotting, cancellation, and trace path as Agents.
   */
  async #callTool(
    value: AmlTool<never, unknown>,
    input: unknown,
    context: EvaluationContext,
    parent: AmlTraceIdentity
  ) {
    context.signal.throwIfAborted()
    const registered = registeredAmlTool(value)

    if (registered === undefined) {
      throw new EvaluationError("Only an exact Tool returned by defineTool() can be called")
    }

    const instrumented = instrumentAgentTools([registered], context, parent, { invocation: "application" })[0]

    if (instrumented === undefined) {
      throw new EvaluationError("AML could not prepare the Tool call")
    }

    return await instrumented.execute(input, {
      signal: context.signal,
      trace: parent,
    })
  }

  /**
   * Creates a lexical application-span runner without exposing trace allocation.
   */
  #applicationSpanRunner(context: EvaluationContext, parentSpanId: string): ApplicationSpanRunner {
    return async <Result>(
      name: string,
      operation: (childRunner: ApplicationSpanRunner, parentSpanId: string) => PromiseLike<Result> | Result
    ): Promise<Result> => {
      context.signal.throwIfAborted()
      const trace = context.createObservationTrace(parentSpanId)
      const span = context.startTraceSpan(trace, "application", name)

      try {
        const result = await operation(this.#applicationSpanRunner(context, trace.spanId), trace.spanId)
        context.signal.throwIfAborted()
        context.endTraceSpan(span, "ok")
        return result
      } catch (error) {
        const failure = context.signal.aborted ? context.signal.reason : error
        context.failTraceSpan(span, failure)
        throw failure
      }
    }
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
        throw new EvaluationError("non-whitespace Agent text cannot follow <FollowUp>")
      }

      return
    }

    target.promptChunks.push(value)
    return
  }

  // Structured evaluation returns an Agent's typed value, so adjacent rendered
  // text would create a second incompatible result channel.
  if (target.structured !== undefined && target.source === "evaluation" && value.length > 0) {
    throw new EvaluationError("Structured evaluate() cannot include text outside its <Agent>")
  }

  target.chunks.push(value)
}

/**
 * Captures one normalized exact-name capability allowlist for a runtime.
 */
function captureAllowedNames(
  values: readonly string[] | undefined,
  label: "allowedMcpServers" | "allowedTools"
): ReadonlySet<string> | undefined {
  if (values === undefined) {
    return undefined
  }

  if (!Array.isArray(values)) {
    throw new TypeError(`${label} must be an array`)
  }

  const result = new Set<string>()

  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
      throw new TypeError(`${label} entries must be non-empty normalized strings`)
    }

    result.add(value)
  }

  return result
}

/**
 * Captures the runtime-wide observer boundary exactly once.
 */
function captureTraceOptions(
  trace: TraceSink | undefined,
  onError: TraceErrorHandler | undefined
): Readonly<{
  onError: TraceErrorHandler | undefined
  sink: TraceSink | undefined
}> {
  if (trace !== undefined && typeof trace !== "function") {
    throw new TypeError("trace must be a function")
  }

  if (onError !== undefined && typeof onError !== "function") {
    throw new TypeError("onTraceError must be a function")
  }

  return Object.freeze({
    onError,
    sink: trace,
  })
}

/**
 * Removes one post-order span and rejects impossible lifecycle ordering.
 */
function removeActiveTraceSpan(active: TraceSpan[], expected: TraceSpan): void {
  const span = active.pop()

  if (span !== expected) {
    throw new EvaluationError("AML trace spans completed out of lifecycle order")
  }
}

/**
 * Reads a component's diagnostic name without letting an exotic function
 * wrapper turn optional instrumentation into a workflow failure.
 */
function traceComponentName(component: Function): string {
  try {
    const name = ComponentEvaluationContext.withoutAccess(() => Reflect.get(component, "name"))

    return typeof name === "string" && name.length > 0 ? name : "AnonymousComponent"
  } catch {
    return "AnonymousComponent"
  }
}
