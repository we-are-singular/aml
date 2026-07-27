/**
 * Portable data that may cross an AML provider boundary.
 */
export type AmlJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly AmlJsonValue[]
  | { readonly [key: string]: AmlJsonValue }
