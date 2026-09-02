import type { TextFileInspection } from "./text-file-inspection.js"

/** Metadata retained for one unchanged Include file revision. */
export interface CachedIncludeFile {
  readonly content: string | null
  readonly lines: number
  readonly size: number
}

/**
 * Retains bounded Include snapshots by file revision.
 *
 * Request-specific `maxBytes` never affects retention: callers decide whether
 * to inline a cached body. This owner only drops bodies above the cache memory
 * ceiling and evicts the oldest revision when the entry ceiling is reached.
 */
export class IncludeFileCache {
  readonly #entries = new Map<string, Readonly<CachedIncludeFile>>()

  constructor(
    readonly maxEntries: number,
    readonly maxContentBytes: number
  ) {}

  /** Returns a retained revision, or `undefined` when it must be inspected. */
  get(key: string | undefined): Readonly<CachedIncludeFile> | undefined {
    // A provider without modification times cannot produce a freshness-safe key.
    return key === undefined ? undefined : this.#entries.get(key)
  }

  /**
   * Stores metadata and any body allowed by the cache memory ceiling.
   *
   * Setting an existing metadata-only revision promotes it in place when a
   * later Include had to load the body. Promotion does not make an old entry
   * appear new for FIFO eviction purposes.
   */
  set(key: string | undefined, inspected: Readonly<TextFileInspection>): void {
    if (key === undefined) return

    const existing = this.#entries.get(key)
    const content = inspected.size <= this.maxContentBytes ? inspected.content : null

    if (existing !== undefined) {
      this.#entries.set(
        key,
        Object.freeze({ content: content ?? existing.content, lines: inspected.lines, size: inspected.size })
      )
      return
    }

    if (this.#entries.size >= this.maxEntries) this.#entries.delete(this.#entries.keys().next().value as string)
    this.#entries.set(key, Object.freeze({ content, lines: inspected.lines, size: inspected.size }))
  }
}
