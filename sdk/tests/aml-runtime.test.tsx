import { describe, expect, it } from "vitest"
import type { AmlNode, AmlRenderable } from "../src/core/aml-node.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { EvaluationError } from "../src/core/evaluation-error.js"
import { Fragment, jsx, jsxs } from "../src/jsx-runtime.js"

describe("AmlRuntime", () => {
  it("concatenates supported values without implicit separators", async () => {
    const runtime = new AmlRuntime()
    const tree = jsxs(Fragment, {
      children: ["alpha", 42, false, null, ["beta", jsxs(Fragment, { children: ["gamma", undefined] })]],
    })

    await expect(runtime.evaluate(tree)).resolves.toBe("alpha42betagamma")
  })

  it("rejects an already-cancelled evaluation before rendering", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled before evaluation")
    let rendered = false

    function Component() {
      rendered = true
      return "unreachable"
    }

    controller.abort(reason)

    await expect(
      new AmlRuntime().evaluate(jsx(Component, {}), {
        signal: controller.signal,
      })
    ).rejects.toBe(reason)
    expect(rendered).toBe(false)
  })

  it("does not advance to another AML frame after cancellation", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled during evaluation")
    let secondRendered = false

    async function First() {
      await Promise.resolve()
      controller.abort(reason)
      return "first"
    }

    function Second() {
      secondRendered = true
      return "second"
    }

    await expect(
      new AmlRuntime().evaluate([jsx(First, {}), jsx(Second, {})], { signal: controller.signal })
    ).rejects.toBe(reason)
    expect(secondRendered).toBe(false)
  })

  it("supports named and shorthand Fragment syntax", async () => {
    const runtime = new AmlRuntime()
    const tree = (
      <>
        <Fragment>named</Fragment>
        <>shorthand</>
      </>
    )

    await expect(runtime.evaluate(tree)).resolves.toBe("namedshorthand")
  })

  it("awaits components in authored order", async () => {
    const events: string[] = []

    async function First() {
      events.push("first:start")
      await Promise.resolve()
      events.push("first:end")
      return "A"
    }

    async function Second() {
      events.push("second:start")
      await Promise.resolve()
      events.push("second:end")
      return "B"
    }

    const runtime = new AmlRuntime()
    const output = await runtime.evaluate([jsx(First, {}), jsx(Second, {})])

    expect(output).toBe("AB")
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"])
  })

  it("reads array siblings only when they reach authored order", async () => {
    const events: string[] = []
    const siblings: AmlRenderable[] = []

    Object.defineProperty(siblings, 0, {
      get() {
        events.push("first:get")
        return "A"
      },
    })
    Object.defineProperty(siblings, 1, {
      get() {
        events.push("second:get")
        return "B"
      },
    })
    siblings.length = 2

    await expect(new AmlRuntime().evaluate(siblings)).resolves.toBe("AB")
    expect(events).toEqual(["first:get", "second:get"])
  })

  it("observes later siblings after earlier components settle", async () => {
    const siblings: AmlRenderable[] = []

    async function First() {
      await Promise.resolve()
      siblings[1] = "updated"
      return "first:"
    }

    siblings.push(jsx(First, {}), "stale")

    await expect(new AmlRuntime().evaluate(siblings)).resolves.toBe("first:updated")
  })

  it("preserves output order for Promises the application already started", async () => {
    const events: string[] = []
    const first = new Promise<string>(resolve => {
      events.push("first:started")
      setTimeout(() => resolve("A"), 5)
    })
    const second = new Promise<string>(resolve => {
      events.push("second:started")
      resolve("B")
    })

    expect(events).toEqual(["first:started", "second:started"])

    const runtime = new AmlRuntime()
    await expect(runtime.evaluate([first, second])).resolves.toBe("AB")
  })

  it("invokes a reused JSX value once per evaluated occurrence", async () => {
    let calls = 0

    function Counted() {
      calls += 1
      return calls
    }

    const component = jsx(Counted, {})
    const runtime = new AmlRuntime()

    await expect(runtime.evaluate([component, component])).resolves.toBe("12")
    expect(calls).toBe(2)
  })

  it("rejects unsupported objects", async () => {
    const runtime = new AmlRuntime()

    await expect(runtime.evaluate({ value: "not renderable" } as never)).rejects.toThrow(
      new EvaluationError("AML cannot render a value of type object")
    )
  })

  it("rejects intrinsic JSX element types", async () => {
    const runtime = new AmlRuntime()

    await expect(runtime.evaluate(jsx("div" as never, { children: "no HTML" }))).rejects.toThrow(
      "AML does not support intrinsic or unknown JSX element types"
    )
  })

  it("rejects cyclic arrays", async () => {
    const cyclic: unknown[] = []
    cyclic.push(cyclic)

    const runtime = new AmlRuntime()

    await expect(runtime.evaluate(cyclic as never)).rejects.toThrow("AML arrays cannot contain cycles")
  })

  it("rejects array cycles that cross a Promise boundary", async () => {
    let resolveChild: ((value: AmlRenderable) => void) | undefined
    const child = new Promise<AmlRenderable>(resolve => {
      resolveChild = resolve
    })
    const cyclic: AmlRenderable[] = [child]

    resolveChild?.(cyclic)

    await expect(new AmlRuntime().evaluate(cyclic)).rejects.toThrow("AML arrays cannot contain cycles")
  })

  it("rejects cycles that cross an async component boundary", async () => {
    let calls = 0
    async function Recursive() {
      calls += 1
      await Promise.resolve()
      return node
    }

    const node: AmlNode<{}> = jsx(Recursive, {})

    await expect(new AmlRuntime({ maxDepth: 0 }).evaluate(node)).rejects.toThrow("AML nodes cannot contain cycles")
    expect(calls).toBe(1)
  })

  it("evaluates deeply nested arrays without using the VM call stack", async () => {
    let tree: unknown = "done"

    for (let depth = 0; depth < 20_000; depth += 1) {
      tree = [tree]
    }

    await expect(new AmlRuntime().evaluate(tree as never)).resolves.toBe("done")
  })

  it("bounds recursively returned component nodes", async () => {
    function Recursive({ remaining }: { remaining: number }) {
      return remaining === 0 ? "done" : jsx(Recursive, { remaining: remaining - 1 })
    }

    const runtime = new AmlRuntime({ maxDepth: 2 })

    await expect(runtime.evaluate(jsx(Recursive, { remaining: 2 }))).rejects.toThrow(
      "AML evaluation exceeded maxDepth 2"
    )
  })

  it("accepts zero as an unlimited depth setting", async () => {
    function Recursive({ remaining }: { remaining: number }) {
      return remaining === 0 ? "done" : jsx(Recursive, { remaining: remaining - 1 })
    }

    const runtime = new AmlRuntime({ maxDepth: 0 })

    await expect(runtime.evaluate(jsx(Recursive, { remaining: 20 }))).resolves.toBe("done")
  })

  it("evaluates deep component chains when depth is unlimited", async () => {
    function Recursive({ remaining }: { remaining: number }) {
      return remaining === 0 ? "done" : jsx(Recursive, { remaining: remaining - 1 })
    }

    const runtime = new AmlRuntime({ maxDepth: 0 })

    await expect(runtime.evaluate(jsx(Recursive, { remaining: 20_000 }))).resolves.toBe("done")
  })

  it("reads a PromiseLike then accessor exactly once", async () => {
    let reads = 0
    const promise = Promise.resolve("done")
    const value: PromiseLike<string> = {
      get then(): PromiseLike<string>["then"] {
        reads += 1
        return promise.then.bind(promise)
      },
    }

    await expect(new AmlRuntime().evaluate(value)).resolves.toBe("done")
    expect(reads).toBe(1)
  })

  it("invokes PromiseLike then on a microtask like native await", async () => {
    const events: string[] = []
    const value = {
      then(resolve: (value: string) => void) {
        events.push("then")
        resolve("done")
      },
    } as unknown as PromiseLike<string>

    const evaluation = new AmlRuntime().evaluate(value)
    events.push("after evaluate")

    expect(events).toEqual(["after evaluate"])
    await expect(evaluation).resolves.toBe("done")
    expect(events).toEqual(["after evaluate", "then"])
  })

  it("does not add a PromiseLike has-property probe", async () => {
    const events: string[] = []
    const promise = Promise.resolve("done")
    const value = new Proxy<PromiseLike<string>>(
      { then: promise.then.bind(promise) },
      {
        get(target, property, receiver) {
          events.push(`get:${String(property)}`)
          return Reflect.get(target, property, receiver)
        },
        has(target, property) {
          events.push(`has:${String(property)}`)
          return Reflect.has(target, property)
        },
      }
    )

    await expect(new AmlRuntime().evaluate(value)).resolves.toBe("done")
    expect(events).not.toContain("has:then")
    expect(events.filter(event => event.endsWith(":then"))).toEqual(["get:then"])
  })

  it("rejects invalid depth settings at construction", () => {
    expect(() => new AmlRuntime({ maxDepth: -1 })).toThrow("maxDepth must be a non-negative safe integer")
    expect(() => new AmlRuntime({ maxDepth: 1.5 })).toThrow("maxDepth must be a non-negative safe integer")
  })
})
