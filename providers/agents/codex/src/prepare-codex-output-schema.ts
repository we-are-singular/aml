type NormalizedSchema = boolean | Readonly<Record<string, unknown>>

const MAX_CODEX_SCHEMA_DEPTH = 128

const OBJECT_APPLICATOR_KEYWORDS = [
  "additionalProperties",
  "dependentRequired",
  "dependentSchemas",
  "maxProperties",
  "minProperties",
  "patternProperties",
  "properties",
  "propertyNames",
  "required",
  "unevaluatedProperties",
] as const

const SCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const

const SCHEMA_MAP_KEYWORDS = ["$defs", "definitions", "dependentSchemas", "patternProperties"] as const

const SCHEMA_VALUE_KEYWORDS = [
  "contains",
  "contentSchema",
  "else",
  "if",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const

/**
 * Produces the strict object schemas required by Codex structured output.
 *
 * Standard JSON Schema permits open objects by default, while the Codex
 * response format requires every object boundary to set
 * `additionalProperties: false`. Optional object properties cannot be made
 * required without changing application semantics, so the adapter rejects
 * those schemas instead of silently rewriting their output shape.
 */
export function prepareCodexOutputSchema(schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const normalized = normalizeSchemaNode(schema, "$")

  // The public contract requires an object root even though nested JSON Schema
  // branches may use the boolean-schema shorthand.
  if (typeof normalized === "boolean") {
    throw new TypeError("Codex output schema $ must be an object")
  }

  return normalized
}

/**
 * Recursively normalizes every standard schema-bearing branch.
 */
function normalizeSchemaNode(value: unknown, path: string, depth = 0): NormalizedSchema {
  if (typeof value === "boolean") {
    return value
  }

  if (depth > MAX_CODEX_SCHEMA_DEPTH) {
    throw new TypeError(`Codex output schema exceeds the maximum depth of ${MAX_CODEX_SCHEMA_DEPTH}`)
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Codex output schema ${path} must be an object or boolean`)
  }

  const schema = value as Readonly<Record<string, unknown>>

  // Object.fromEntries creates data properties even for "__proto__"; direct
  // assignment would instead mutate the accumulator's prototype.
  const output = Object.fromEntries(Object.entries(schema))

  // Combinators and tuple schemas contain ordered schema lists.
  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    const branches = schema[keyword]

    if (branches === undefined) {
      continue
    }

    if (!Array.isArray(branches)) {
      throw new TypeError(`Codex output schema ${path}.${keyword} must be an array`)
    }

    output[keyword] = Object.freeze(
      branches.map((branch, index) => normalizeSchemaNode(branch, `${path}.${keyword}[${index}]`, depth + 1))
    )
  }

  // These keywords contain exactly one child schema.
  for (const keyword of SCHEMA_VALUE_KEYWORDS) {
    const child = schema[keyword]

    if (child !== undefined) {
      output[keyword] = normalizeSchemaNode(child, `${path}.${keyword}`, depth + 1)
    }
  }

  // Draft 2020-12 uses one schema for items, while older drafts also permit
  // an ordered array. Supporting both keeps the provider boundary portable.
  if (schema.items !== undefined) {
    output.items = Array.isArray(schema.items)
      ? Object.freeze(
          schema.items.map((item, index) => normalizeSchemaNode(item, `${path}.items[${index}]`, depth + 1))
        )
      : normalizeSchemaNode(schema.items, `${path}.items`, depth + 1)
  }

  // Definition and pattern keywords contain name-to-schema dictionaries.
  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const children = schema[keyword]

    if (children === undefined) {
      continue
    }

    output[keyword] = normalizeSchemaMap(children, `${path}.${keyword}`, depth + 1)
  }

  const properties = schema.properties

  if (properties !== undefined) {
    const normalizedProperties = normalizeSchemaMap(properties, `${path}.properties`, depth + 1)

    output.properties = normalizedProperties
    const propertyNames = Object.keys(normalizedProperties)
    const required = schema.required ?? []

    if (!Array.isArray(required) || required.some(name => typeof name !== "string")) {
      throw new TypeError(`Codex output schema ${path}.required must list every object property`)
    }

    const requiredNames = new Set(required)
    const optional = propertyNames.filter(name => !requiredNames.has(name))

    if (optional.length > 0) {
      throw new TypeError(
        `Codex output schema ${path} has optional properties unsupported by strict output: ${optional.join(", ")}`
      )
    }

    output.required = Object.freeze([...required])
  }

  const appliesToObjects =
    schema.type === "object" ||
    (Array.isArray(schema.type) && schema.type.includes("object")) ||
    OBJECT_APPLICATOR_KEYWORDS.some(keyword => schema[keyword] !== undefined)

  if (appliesToObjects && schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new TypeError(`Codex output schema ${path}.additionalProperties must be false`)
  }

  if (appliesToObjects) {
    output.additionalProperties = false
  }

  return Object.freeze(output)
}

/**
 * Normalizes a dictionary without treating authored keys as object setters.
 */
function normalizeSchemaMap(
  value: unknown,
  path: string,
  childDepth: number
): Readonly<Record<string, NormalizedSchema>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Codex output schema ${path} must be an object`)
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([name, child]) => [name, normalizeSchemaNode(child, `${path}.${name}`, childDepth)])
    )
  )
}
