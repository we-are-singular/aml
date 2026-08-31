import { AmlNode, type AmlRenderable } from "../../core/aml-node.js"
import type { WorkspaceProvider } from "./workspace-provider.js"

/** Selects and filters the durable revision loaded before Workspace children run. */
export interface WorkspaceLoadOptions {
  /**
   * Relative forward-slash globs removed from the load selection.
   *
   * Defaults to an empty list. Patterns cannot use negation, absolute paths,
   * backslashes, or parent traversal.
   */
  readonly exclude?: readonly string[]

  /**
   * Relative forward-slash globs that limit which files are loaded.
   *
   * Omission includes every file not removed by `exclude`.
   */
  readonly include?: readonly string[]

  /**
   * Revision identifier to materialize.
   *
   * Defaults to `"current"`. A supplied identifier must be non-empty and
   * normalized; providers define how immutable revision IDs are represented.
   */
  readonly revision?: "current" | string
}

/** Controls if and how a Workspace publishes a new durable revision. */
export interface WorkspaceSaveOptions {
  /**
   * Relative forward-slash globs removed from the save selection.
   *
   * Defaults to an empty list and follows the same normalization rules as load
   * patterns.
   */
  readonly exclude?: readonly string[]

  /**
   * Whether `.gitignore` rules participate in the save selection.
   *
   * Defaults to `true`.
   */
  readonly gitignore?: boolean

  /**
   * Relative forward-slash globs that limit which files are saved.
   *
   * Omission considers every file not removed by `exclude` or `.gitignore`.
   */
  readonly include?: readonly string[]

  /**
   * Descendant outcome on which AML publishes a revision.
   *
   * Defaults to `"success"`. `"always"` also saves after ordinary descendant
   * failure, but cancellation never triggers a save.
   */
  readonly on?: "always" | "success"

  /**
   * Total revisions retained, including the newly published current revision.
   *
   * Defaults to `1` and must be a positive safe integer.
   */
  readonly retention?: number
}

/**
 * Filesystem isolation, optional durable state, and authored Workspace subtree.
 */
export interface WorkspaceProps {
  /**
   * AML values evaluated inside the acquired materialization.
   *
   * Omission evaluates an empty scope while still applying configured load,
   * save, and release behavior.
   */
  readonly children?: AmlRenderable

  /**
   * Portable logical working directory exposed to descendants.
   *
   * Defaults to `"."` within the materialization and cannot escape it.
   */
  readonly cwd?: string

  /**
   * Non-empty normalized durable Workspace identity.
   *
   * AML generates a UUID when omitted. Supply a stable ID when later runs must
   * reopen the same revisions.
   */
  readonly id?: string

  /**
   * Revision materialization policy applied before descendants run.
   *
   * Defaults to `true`, which loads the current revision without filters.
   * `false` starts from an empty provider materialization.
   */
  readonly load?: boolean | WorkspaceLoadOptions

  /**
   * Whether acquisition requests exclusive durable-writer coordination.
   *
   * Defaults to `true`. Providers define the lock implementation and report a
   * `WorkspaceConflictError` when a competing acquisition cannot proceed.
   */
  readonly lock?: boolean

  /**
   * Provider that materializes and optionally persists this Workspace.
   *
   * When omitted, AML uses `AmlRuntimeOptions.workspaceProvider`. Evaluation
   * fails if neither location supplies a provider.
   */
  readonly provider?: WorkspaceProvider

  /**
   * Durable publication policy applied before provider release.
   *
   * Defaults to `false`. `true` uses the `WorkspaceSaveOptions` defaults; an
   * options object enables filtering, outcome, retention, and gitignore policy.
   */
  readonly save?: boolean | WorkspaceSaveOptions

  /**
   * Coordination policy for writable sibling Sandboxes in this materialization.
   *
   * Defaults to `"serial"`. `"parallel"` permits concurrent writers and makes
   * conflict safety the application and provider's responsibility.
   */
  readonly writeConcurrency?: "parallel" | "serial"
}

/**
 * Acquires one top-level materialization and scopes it to descendant work.
 *
 * AML loads before evaluating children, applies the outcome-aware save policy,
 * and releases the provider lease exactly once. An evaluation supports at most
 * one Workspace boundary, which must be the top-level resource scope.
 */
export function Workspace(_props: WorkspaceProps): never {
  throw new Error("<Workspace> can only be evaluated by AmlRuntime")
}

AmlNode.markPrimitive(Workspace, "workspace")
