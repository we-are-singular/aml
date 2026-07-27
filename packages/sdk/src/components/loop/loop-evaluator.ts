import { isDeepStrictEqual } from "node:util"

import type { StandardSchemaV1 } from "@standard-schema/spec"

import type { AmlJsonValue } from "../../core/aml-json-value.js"
import type { AmlRenderable } from "../../core/aml-node.js"
import type { EvaluationContext } from "../../core/evaluation-context.js"
import { EvaluationError } from "../../core/evaluation-error.js"
import type {
  AgentJavaScriptTool,
  AgentToolExecutionContext,
} from "../tool/agent-tool.js"
import { JsonSnapshot } from "../tool/json-snapshot.js"
import {
  type SchemaValidation,
  StandardSchemaAdapter,
} from "../tool/standard-schema-adapter.js"
import type {
  DeepReadonly,
  LoopProps,
  LoopRenderContext,
} from "./loop.js"

type LoopState = Readonly<Record<string, AmlJsonValue>>

const LOOP_STATE_TOOL_INPUT = Object.freeze({
  additionalProperties: false,
  properties: Object.freeze({
    updates: Object.freeze({
      minProperties: 1,
      type: "object",
    }),
  }),
  required: Object.freeze(["updates"]),
  type: "object",
})

/**
 * Owns validation, capability lifetime, and atomic commits for `<Loop>`.
 */
export class LoopEvaluator {
  /**
   * Runs fresh Agent sessions until an iteration leaves staged state unchanged.
   */
  async evaluate<
    Schema extends StandardSchemaV1<
      unknown,
      Record<string, unknown>
    >,
  >(
    props: Readonly<LoopProps<Schema>>,
    context: EvaluationContext,
    executeAgent: (
      value: AmlRenderable,
      stateTool: AgentJavaScriptTool,
    ) => Promise<string>,
  ): Promise<string> {
    const children = Reflect.get(props, "children")
    const initial = Reflect.get(props, "initial")
    const configuredName = Reflect.get(props, "name")
    const render = Reflect.get(props, "render")
    const schema = Reflect.get(props, "schema")

    if (children !== undefined) {
      throw new EvaluationError(
        "<Loop> accepts render() instead of children",
      )
    }

    const name = configuredName ?? "Loop"

    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name !== name.trim()
    ) {
      throw new EvaluationError(
        "<Loop> name must be a non-empty normalized string",
      )
    }

    if (typeof render !== "function") {
      throw new EvaluationError("<Loop> render must be a function")
    }

    const stateSchema = new LoopStateSchema(schema, name)
    let snapshot = await stateSchema.validate(initial)
    const allowedKeys = Object.freeze(Object.keys(snapshot))
    let iteration = 0

    while (true) {
      context.signal.throwIfAborted()
      iteration += 1

      // Each iteration receives a new capability. Expiration prevents a
      // provider from retaining authority after its Agent session settles.
      const stateTool = new LoopStateTool(
        name,
        snapshot,
        allowedKeys,
        stateSchema,
      )
      const renderContext: LoopRenderContext<
        StandardSchemaV1.InferOutput<Schema>
      > = Object.freeze({
        iteration,
        state: snapshot as DeepReadonly<
          StandardSchemaV1.InferOutput<Schema>
        >,
      })
      let output: string

      try {
        const value = Reflect.apply(render, undefined, [renderContext])
        output = await executeAgent(value, stateTool)
      } finally {
        // Provider adapters must join their outstanding Tool calls before
        // returning. Any incorrectly detached call now fails before mutation.
        stateTool.expire()
      }

      const staged = stateTool.state

      if (isDeepStrictEqual(snapshot, staged)) {
        return output
      }

      // The evaluation-wide budget is reserved immediately before the commit;
      // rejected transitions therefore never become observable Loop state.
      context.reserveStateTransition(name, iteration)
      snapshot = staged
    }
  }
}

/**
 * Captures one Standard Schema and enforces idempotent stable-JSON output.
 */
class LoopStateSchema {
  readonly #adapter: StandardSchemaAdapter
  readonly #label: string

  constructor(schema: unknown, name: string) {
    this.#label = `<Loop name="${name}"> state`
    this.#adapter = new StandardSchemaAdapter(
      schema as StandardSchemaV1,
      false,
      `<Loop name="${name}"> schema`,
    )
  }

  /**
   * Produces a deeply frozen object whose schema normalization is repeatable.
   */
  async validate(value: unknown): Promise<LoopState> {
    const input = this.#captureObject(value)
    const first = await this.#parse(input)
    const normalized = this.#captureObject(first)
    const second = await this.#parse(normalized)
    const repeated = this.#captureObject(second)

    if (!isDeepStrictEqual(normalized, repeated)) {
      throw new EvaluationError(
        `${this.#label} schema must produce stable JSON state`,
      )
    }

    return normalized
  }

  /**
   * Converts a Standard Schema failure into an attributed Loop error.
   */
  async #parse(value: LoopState): Promise<unknown> {
    let result: SchemaValidation

    try {
      result = await this.#adapter.validate(value)
    } catch (cause) {
      throw new EvaluationError(
        `${this.#label} schema validation failed`,
        { cause },
      )
    }

    if (!result.success) {
      const messages = result.issues
        .map((issue) => issue.message)
        .join("; ")

      throw new EvaluationError(
        `${this.#label} failed schema validation: ${messages}`,
        { cause: result.issues },
      )
    }

    return result.value
  }

  /**
   * Rejects non-JSON inputs and schema outputs before they enter Loop state.
   */
  #captureObject(value: unknown): LoopState {
    let captured: AmlJsonValue

    try {
      captured = JsonSnapshot.capture(value, this.#label)
    } catch (cause) {
      throw new EvaluationError(
        `${this.#label} must contain only stable JSON`,
        { cause },
      )
    }

    if (
      typeof captured !== "object" ||
      captured === null ||
      Array.isArray(captured)
    ) {
      throw new EvaluationError(
        `${this.#label} must be a JSON object`,
      )
    }

    return captured as LoopState
  }
}

/**
 * Serializes staged patches and expires with exactly one Agent session.
 */
class LoopStateTool implements AgentJavaScriptTool {
  readonly #allowedKeys: ReadonlySet<string>
  #active = true
  readonly #initialState: LoopState
  readonly #label: string
  readonly #name: string
  readonly #schema: LoopStateSchema
  #state: LoopState
  #tail: Promise<void> = Promise.resolve()
  readonly description: string
  readonly inputSchema = LOOP_STATE_TOOL_INPUT
  readonly kind = "javascript" as const
  readonly name = "aml_set_state"

  constructor(
    name: string,
    state: LoopState,
    allowedKeys: readonly string[],
    schema: LoopStateSchema,
  ) {
    this.#allowedKeys = new Set(allowedKeys)
    this.#initialState = state
    this.#label = `"${name}" Loop state`
    this.#name = name
    this.#schema = schema
    this.#state = state
    this.description = [
      `Stage a "${name}" state patch for the next Loop iteration.`,
      "State does not change during this Agent session.",
      "Put coupled field changes in one updates object.",
      `Allowed keys: ${allowedKeys.join(", ") || "(none)"}.`,
      "When staged state differs, finish the session so AML can commit it.",
    ].join(" ")

    // Public capability metadata must remain stable while providers attach it.
    // Private fields stay mutable so Tool calls can stage state after freezing.
    Object.freeze(this)
  }

  /**
   * Returns the last completely validated staged snapshot.
   */
  get state(): LoopState {
    return this.#state
  }

  /**
   * Prevents retained or detached provider calls from changing staged state.
   */
  expire(): void {
    this.#active = false
  }

  /**
   * Queues one atomic patch so concurrent Tool calls preserve invocation order.
   */
  execute(
    input: unknown,
    context: AgentToolExecutionContext,
  ): Promise<AmlJsonValue> {
    const operation = this.#tail.then(
      async () => await this.#stage(input, context),
    )

    // A rejected call leaves the queue usable while its own returned Promise
    // still reports the validation or expiration failure to the provider.
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    )

    return operation
  }

  /**
   * Validates a complete proposal before replacing the staged snapshot.
   */
  async #stage(
    input: unknown,
    context: AgentToolExecutionContext,
  ): Promise<AmlJsonValue> {
    context.signal.throwIfAborted()
    this.#assertActive()

    let captured: AmlJsonValue

    try {
      captured = JsonSnapshot.capture(
        input,
        `${this.#label} Tool input`,
      )
    } catch (cause) {
      throw new EvaluationError(
        `${this.#label} Tool input must be stable JSON`,
        { cause },
      )
    }

    if (
      typeof captured !== "object" ||
      captured === null ||
      Array.isArray(captured) ||
      Object.keys(captured).length !== 1 ||
      !Object.hasOwn(captured, "updates")
    ) {
      throw new EvaluationError(
        `${this.#label} Tool input must contain only updates`,
      )
    }

    const updates = (
      captured as Readonly<Record<string, AmlJsonValue>>
    ).updates

    if (
      typeof updates !== "object" ||
      updates === null ||
      Array.isArray(updates) ||
      Object.keys(updates).length === 0
    ) {
      throw new EvaluationError(
        `${this.#label} updates must be a non-empty JSON object`,
      )
    }

    const updatedKeys = Object.keys(updates)
    const unknownKeys = updatedKeys.filter(
      (key) => !this.#allowedKeys.has(key),
    )

    if (unknownKeys.length > 0) {
      throw new EvaluationError(
        `${this.#label} cannot update unknown keys: ${unknownKeys.join(", ")}`,
      )
    }

    // Object.fromEntries uses data-property creation, so even an explicitly
    // authored "__proto__" key cannot mutate the proposal's prototype.
    const proposal = Object.fromEntries([
      ...Object.entries(this.#state),
      ...Object.entries(updates),
    ])
    const next = await this.#schema.validate(proposal)

    // Validation may be asynchronous. Recheck both caller control and lease
    // lifetime before publishing its result into staged state.
    context.signal.throwIfAborted()
    this.#assertActive()

    const changed = !isDeepStrictEqual(this.#state, next)
    this.#state = next

    return Object.freeze({
      changed,
      updated: Object.freeze(updatedKeys),
      willRepeat: !isDeepStrictEqual(this.#initialState, next),
    })
  }

  /**
   * Attributes expired capability use to the Loop that granted it.
   */
  #assertActive(): void {
    if (!this.#active) {
      throw new EvaluationError(
        `"${this.#name}" state capability expired when its Agent finished`,
      )
    }
  }
}
