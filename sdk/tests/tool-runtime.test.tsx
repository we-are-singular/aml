import { z } from "zod"
import { describe, expect, expectTypeOf, it, vi } from "vitest"

import { Agent } from "../src/components/agent/agent.js"
import type { AgentToolExecutionContext } from "../src/components/tool/agent-tool.js"
import { defineTool } from "../src/components/tool/define-tool.js"
import { Tool } from "../src/components/tool/tool.js"
import { ToolInputError } from "../src/components/tool/tool-input-error.js"
import { ToolOutputError } from "../src/components/tool/tool-output-error.js"
import { AmlRuntime } from "../src/core/aml-runtime.js"
import { DeterministicAgentProvider } from "../src/testing/deterministic-agent-provider.js"

describe("Tool", () => {
  it("collects JavaScript capabilities without adding prompt text", async () => {
    const lookup = defineTool({
      description: "Look up a customer",
      input: z.object({ id: z.number() }),
      name: "lookup_customer",
      async execute(input, context) {
        expectTypeOf(input).toEqualTypeOf<{ id: number }>()
        expectTypeOf(context).toEqualTypeOf<AgentToolExecutionContext>()
        return { id: input.id, status: "active" }
      },
    })
    const provider = new DeterministicAgentProvider({
      async respond(request, context) {
        expect(request.prompt).toBe("Inspect the customer.")
        expect(request.tools.map(({ name }) => name)).toEqual(["lookup_customer"])

        const tool = request.tools[0]
        expect(tool).toMatchObject({
          description: "Look up a customer",
          inputSchema: {
            properties: { id: { type: "number" } },
            required: ["id"],
            type: "object",
          },
          kind: "javascript",
          name: "lookup_customer",
        })

        if (tool?.kind !== "javascript") {
          throw new Error("Expected JavaScript Tool")
        }

        await expect(
          tool.execute(
            { id: 42 },
            {
              signal: context.signal,
              trace: context.trace,
            }
          )
        ).resolves.toEqual({ id: 42, status: "active" })

        return { text: "done" }
      },
    })

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          <Tool use={lookup} />
          Inspect the customer.
        </Agent>
      )
    ).resolves.toBe("done")
  })

  it("scopes capabilities to their containing Agent", async () => {
    const childTool = fixtureTool("child")
    const parentTool = fixtureTool("parent")
    const child = new DeterministicAgentProvider({
      respond(request) {
        expect(request.tools.map(({ name }) => name)).toEqual(["child"])
        return { text: "child output" }
      },
    })
    const parent = new DeterministicAgentProvider({
      respond(request) {
        expect(request.tools.map(({ name }) => name)).toEqual(["parent"])
        expect(request.prompt).toBe("child outputparent prompt")
        return { text: "done" }
      },
    })

    await expect(
      new AmlRuntime().evaluate(
        <Agent provider={parent}>
          <Agent provider={child}>
            <Tool use={childTool} />
            child prompt
          </Agent>
          <Tool use={parentTool} />
          parent prompt
        </Agent>
      )
    ).resolves.toBe("done")
  })

  it("rejects invalid placement, duplicates, and disallowed names before execution", async () => {
    const provider = new DeterministicAgentProvider()
    const read = fixtureTool("read")

    await expect(new AmlRuntime().evaluate(<Tool use={read} />)).rejects.toThrow("<Tool> is only valid inside <Agent>")
    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          <Tool use={read} />
          <Tool use={read} />
        </Agent>
      )
    ).rejects.toThrow('Agent declares duplicate Tool "read"')
    await expect(
      new AmlRuntime({
        agentProvider: provider,
        allowedTools: ["grep"],
      }).evaluate(
        <Agent>
          <Tool use={read} />
          prompt
        </Agent>
      )
    ).rejects.toThrow('Tool "read" is not allowed by this runtime')
    expect(provider.calls).toHaveLength(0)
  })

  it("rejects structural, cloned, derived, and proxied Tool lookalikes", async () => {
    const provider = new DeterministicAgentProvider()
    const unsafeExecute = vi.fn(async () => "unsafe")
    const structuralTool = {
      description: "Bypass validation",
      execute: unsafeExecute,
      inputSchema: { type: "object" },
      kind: "javascript",
      name: "structural",
    } as const
    const legitimate = defineTool({
      description: "Validate an ID",
      input: z.object({ id: z.number() }),
      name: "legitimate",
      execute: async ({ id }) => id,
    })
    const derived = Object.defineProperty(Object.create(legitimate), "execute", {
      value: unsafeExecute,
    })
    const lookalikes = [structuralTool, { ...legitimate, execute: unsafeExecute }, derived, new Proxy(legitimate, {})]

    expect(legitimate.__amlTool).toBe(true)
    expect(Object.keys(legitimate)).not.toContain("__amlTool")

    for (const lookalike of lookalikes) {
      await expect(
        new AmlRuntime({ agentProvider: provider }).evaluate(
          <Agent>
            <Tool use={lookalike as never} />
            prompt
          </Agent>
        )
      ).rejects.toThrow("<Tool use> must be a JavaScript Tool")
    }

    expect(unsafeExecute).not.toHaveBeenCalled()
    expect(provider.calls).toHaveLength(0)
  })
})

function fixtureTool(name: string) {
  return defineTool({
    description: `Fixture ${name}`,
    input: z.object({}),
    name,
    execute: async () => name,
  })
}

describe("defineTool", () => {
  it("returns an immutable callable accepted by <Tool use>", async () => {
    const provider = new DeterministicAgentProvider({ respond: () => ({ text: "done" }) })
    const tool = defineTool({
      description: "Read an ID",
      execute: async ({ id }) => ({ id }),
      input: z.object({ id: z.number() }),
      name: "callable",
      output: z.object({ id: z.number() }),
    })

    expectTypeOf(tool).toBeCallableWith({ id: 42 })
    expect(typeof tool).toBe("function")
    expect(Object.isFrozen(tool)).toBe(true)
    expect(tool.description).toBe("Read an ID")
    expect(tool.kind).toBe("javascript")
    expect(tool.name).toBe("callable")

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          <Tool use={tool} />
          prompt
        </Agent>
      )
    ).resolves.toBe("done")
    expect(provider.calls[0]?.request.tools.map(({ name }) => name)).toEqual(["callable"])
  })

  it("accepts an inline defineTool() result as a model grant", async () => {
    const provider = new DeterministicAgentProvider({
      respond(request) {
        expect(request.tools.map(({ name }) => name)).toEqual(["inline"])
        return { text: "done" }
      },
    })

    await expect(
      new AmlRuntime({ agentProvider: provider }).evaluate(
        <Agent>
          <Tool
            use={defineTool({
              description: "Inline capability",
              execute: async () => "inline result",
              input: z.object({}),
              name: "inline",
            })}
          />
          prompt
        </Agent>
      )
    ).resolves.toBe("done")
  })

  it("implements exact transport input normalization", async () => {
    const objectExecute = vi.fn(async ({ id }: { id: number }) => id)
    const objectTool = defineTool({
      description: "Read an ID",
      execute: objectExecute,
      input: z.object({ id: z.number() }),
      name: "read_id",
    })
    const context = {
      signal: new AbortController().signal,
      trace: { runId: "run", spanId: "span" },
    }

    await expect(objectTool.execute({ id: 7 }, context)).resolves.toBe(7)
    await expect(objectTool.execute('{"id":8}', context)).resolves.toBe(8)
    expect(objectExecute).toHaveBeenCalledTimes(2)

    const stringTool = defineTool({
      description: "Echo a string",
      input: z.string(),
      name: "echo",
      execute: async value => value,
    })

    await expect(stringTool.execute('{"not":"decoded"}', context)).resolves.toBe('{"not":"decoded"}')

    const emptyTool = defineTool({
      description: "Accept omitted input",
      input: z.object({}),
      name: "empty",
      execute: async () => "ok",
    })

    await expect(emptyTool.execute(undefined, context)).resolves.toBe("ok")
    await expect(objectTool.execute("not JSON", context)).rejects.toBeInstanceOf(ToolInputError)
    expect(objectExecute).toHaveBeenCalledTimes(2)
  })

  it("validates and snapshots output after optional schema transformation", async () => {
    const transformed = defineTool({
      description: "Return a normalized record",
      input: z.object({}),
      name: "normalize",
      output: z.object({ value: z.string() }).transform(({ value }) => ({ value: value.toUpperCase() })),
      execute: async () => ({ value: "ready" }),
    })
    const context = {
      signal: new AbortController().signal,
      trace: { runId: "run", spanId: "span" },
    }
    const result = await transformed.execute({}, context)

    expect(result).toEqual({ value: "READY" })
    expect(Object.isFrozen(result)).toBe(true)

    const invalid = defineTool({
      description: "Return invalid data",
      input: z.object({}),
      name: "invalid",
      execute: async () => ({ value: Number.NaN }),
    })

    await expect(invalid.execute({}, context)).rejects.toBeInstanceOf(ToolOutputError)

    const schemaRejected = defineTool({
      description: "Fail output validation",
      input: z.object({}),
      name: "schema_rejected",
      output: z.object({ value: z.number() }),
      execute: async () => ({ value: "wrong" }) as never,
    })

    await expect(schemaRejected.execute({}, context)).rejects.toBeInstanceOf(ToolOutputError)
  })

  it("validates definition boundaries synchronously", () => {
    expect(() =>
      defineTool({
        description: "description",
        input: z.object({}),
        name: " invalid",
        execute: async () => "never",
      })
    ).toThrow("Tool name must be a non-empty normalized string")

    expect(() =>
      defineTool({
        description: "description",
        input: {
          "~standard": {
            validate: () => ({ value: {} }),
            vendor: "test",
            version: 1,
          },
        } as never,
        name: "missing_json_schema",
        execute: async () => "never",
      })
    ).toThrow("must implement Standard JSON Schema")
  })

  it("rejects malformed Standard Schema results before execute", async () => {
    const execute = vi.fn(async () => "must not run")
    const context = {
      signal: new AbortController().signal,
      trace: { runId: "run", spanId: "span" },
    }

    for (const result of [{}, [], { issues: [{}] }]) {
      const tool = defineTool({
        description: "Use a malformed schema",
        input: {
          "~standard": {
            jsonSchema: {
              input: () => ({ type: "object" }),
            },
            validate: () => result,
            vendor: "malformed-test",
            version: 1,
          },
        } as never,
        name: "malformed",
        execute,
      })

      await expect(tool.execute({}, context)).rejects.toBeInstanceOf(ToolInputError)
    }

    const accessorError = new Error("value getter failed")
    const resultWithThrowingValue = Object.defineProperty({}, "value", {
      get() {
        throw accessorError
      },
    })
    const accessorTool = defineTool({
      description: "Use a throwing result",
      input: {
        "~standard": {
          jsonSchema: {
            input: () => ({ type: "object" }),
          },
          validate: () => resultWithThrowingValue,
          vendor: "malformed-test",
          version: 1,
        },
      } as never,
      name: "throwing_result",
      execute,
    })

    await expect(accessorTool.execute({}, context)).rejects.toMatchObject({
      cause: accessorError,
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it("accepts a conformant inherited Standard Schema success value", async () => {
    class SuccessResult {
      get value() {
        return { id: 42 }
      }
    }

    const execute = vi.fn(async ({ id }: { id: number }) => id)
    const tool = defineTool({
      description: "Use a class-backed schema result",
      input: {
        "~standard": {
          jsonSchema: {
            input: () => ({
              properties: { id: { type: "number" } },
              required: ["id"],
              type: "object",
            }),
          },
          validate: () => new SuccessResult(),
          vendor: "class-result-test",
          version: 1,
        },
      } as never,
      name: "class_result",
      execute,
    })
    const context = {
      signal: new AbortController().signal,
      trace: { runId: "run", spanId: "span" },
    }

    await expect(tool.execute({ ignored: true }, context)).resolves.toBe(42)
    expect(execute).toHaveBeenCalledWith({ id: 42 }, context)
  })

  it("attributes malformed generated input schemas to Tool definition", () => {
    expect(() =>
      defineTool({
        description: "Generate an invalid input declaration",
        input: {
          "~standard": {
            jsonSchema: {
              input: () => ({ invalid: undefined }),
            },
            validate: (value: unknown) => ({ value }),
            vendor: "invalid-json-schema-test",
            version: 1,
          },
        } as never,
        name: "invalid_declaration",
        execute: async () => "never",
      })
    ).toThrow(new TypeError('Tool "invalid_declaration" input JSON Schema is invalid'))
  })

  it("preserves prototype-sensitive keys and deeply nested JSON", async () => {
    const sensitive = Object.defineProperty({}, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    })
    let deep: unknown = "leaf"

    for (let depth = 0; depth < 20_000; depth += 1) {
      deep = [deep]
    }

    const context = {
      signal: new AbortController().signal,
      trace: { runId: "run", spanId: "span" },
    }
    const sensitiveTool = defineTool({
      description: "Return a prototype-sensitive key",
      input: z.object({}),
      name: "sensitive",
      execute: async () => sensitive as never,
    })
    const deepTool = defineTool({
      description: "Return deeply nested JSON",
      input: z.object({}),
      name: "deep",
      execute: async () => deep as never,
    })
    const sensitiveResult = await sensitiveTool.execute({}, context)
    const deepResult = await deepTool.execute({}, context)

    expect(Object.getPrototypeOf(sensitiveResult)).toBe(Object.prototype)
    expect(Object.hasOwn(sensitiveResult as object, "__proto__")).toBe(true)
    expect(JSON.stringify(sensitiveResult)).toBe('{"__proto__":{"polluted":true}}')

    let current: unknown = deepResult

    for (let depth = 0; depth < 20_000; depth += 1) {
      expect(Array.isArray(current)).toBe(true)
      current = (current as readonly unknown[])[0]
    }

    expect(current).toBe("leaf")
  })
})
