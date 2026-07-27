import type { AmlJsonValue } from "../../core/aml-json-value.js"

interface ArrayFrame {
  readonly kind: "array"
  readonly label: string
  readonly source: readonly unknown[]
  readonly target: AmlJsonValue[]
  index: number
}

interface ObjectFrame {
  readonly keys: readonly string[]
  readonly kind: "object"
  readonly label: string
  readonly source: object
  readonly target: Record<string, AmlJsonValue>
  index: number
}

type SnapshotFrame = ArrayFrame | ObjectFrame

interface SnapshotValue {
  readonly frame?: SnapshotFrame
  readonly value: AmlJsonValue
}

/**
 * Captures one deeply immutable, deterministically keyed JSON value.
 *
 * Failures are boundary-neutral TypeErrors. Callers translate them into
 * definition, evaluation, or Tool-output errors with the correct ownership.
 */
export class JsonSnapshot {
  /**
   * Copies unknown data into deeply frozen, deterministic JSON.
   *
   * Traversal uses explicit frames instead of recursive calls so deeply nested
   * but valid tool results cannot overflow the JavaScript call stack.
   */
  static capture(value: unknown, label: string): AmlJsonValue {
    const active = new Set<object>()
    const root = JsonSnapshot.#start(value, label, active)
    const frames = root.frame ? [root.frame] : []

    while (frames.length > 0) {
      const frame = frames.at(-1)!

      // Complete one array slot at a time and freeze only after its children.
      if (frame.kind === "array") {
        if (frame.index >= frame.source.length) {
          Object.freeze(frame.target)
          active.delete(frame.source)
          frames.pop()
          continue
        }

        const index = frame.index
        frame.index += 1

        if (!Object.hasOwn(frame.source, index)) {
          throw new TypeError(`${frame.label} contains a sparse array`)
        }

        const child = JsonSnapshot.#start(
          Reflect.get(frame.source, index),
          `${frame.label}[${index}]`,
          active,
        )
        frame.target.push(child.value)

        if (child.frame) {
          frames.push(child.frame)
        }

        continue
      }

      // Objects use sorted keys to make serialized tool results deterministic.
      if (frame.index >= frame.keys.length) {
        Object.freeze(frame.target)
        active.delete(frame.source)
        frames.pop()
        continue
      }

      const key = frame.keys[frame.index]!
      frame.index += 1
      const child = JsonSnapshot.#start(
        Reflect.get(frame.source, key),
        `${frame.label}.${key}`,
        active,
      )

      // Assignment to __proto__ mutates an ordinary object's prototype.
      Object.defineProperty(frame.target, key, {
        configurable: false,
        enumerable: true,
        value: child.value,
        writable: false,
      })

      if (child.frame) {
        frames.push(child.frame)
      }
    }

    return root.value
  }

  /**
   * Validates one value and creates a traversal frame for containers.
   */
  static #start(
    value: unknown,
    label: string,
    active: Set<object>,
  ): SnapshotValue {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return { value }
    }

    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError(`${label} contains a non-finite number`)
      }

      return { value }
    }

    if (typeof value !== "object") {
      throw new TypeError(
        `${label} contains unsupported ${typeof value} data`,
      )
    }

    if (active.has(value)) {
      throw new TypeError(`${label} contains a cycle`)
    }

    // The active set tracks only the current ancestry. Shared non-cyclic
    // objects are copied independently when reached through another branch.
    if (Array.isArray(value)) {
      const target: AmlJsonValue[] = []
      const frame: ArrayFrame = {
        index: 0,
        kind: "array",
        label,
        source: value,
        target,
      }
      active.add(value)
      return { frame, value: target }
    }

    const prototype = Object.getPrototypeOf(value)

    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        `${label} contains a non-plain object`,
      )
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`${label} contains symbol keys`)
    }

    // Keep ordinary object semantics for consumers. defineProperty() in the
    // traversal preserves __proto__ as data without invoking its legacy setter.
    const target: Record<string, AmlJsonValue> = {}
    const frame: ObjectFrame = {
      index: 0,
      keys: Object.keys(value).sort(),
      kind: "object",
      label,
      source: value,
      target,
    }
    active.add(value)
    return { frame, value: target }
  }
}
