/**
 * Recursively immutable JSON-compatible data that may cross an AML provider
 * boundary.
 *
 * Values exclude `undefined`, `bigint`, symbols, functions, class instances,
 * and cyclic object graphs. Provider and tool contracts use this shape so data
 * can be snapshotted without depending on application object identity.
 */
export type AmlJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly AmlJsonValue[]
  | {
      /** JSON object properties, addressed by their serialized string keys. */
      readonly [key: string]: AmlJsonValue
    }
