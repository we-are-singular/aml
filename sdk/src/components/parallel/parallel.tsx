import type { AmlRenderable } from "../../core/aml-node.js"
import { evaluate } from "../../core/evaluate.js"
import { EvaluationError } from "../../core/evaluation-error.js"

/** Independent AML branches evaluated concurrently in authored order. */
export interface ParallelProps {
  /**
   * Independent AML branches to evaluate concurrently.
   *
   * Nested child arrays are flattened, nullish and boolean children are ignored,
   * and each Fragment remains one branch. Omission produces no branches.
   */
  readonly children?: AmlRenderable
}

/** Identifies one failed Parallel branch without hiding its original cause. */
export interface ParallelFailure {
  /** Zero-based position of the rejected branch after child-array flattening. */
  readonly branchIndex: number

  /** Original value with which the branch rejected. */
  readonly cause: unknown
}

/** Reports every failed Parallel branch in authored order. */
export class ParallelError extends Error {
  /** Every rejected branch, ordered by authored branch position. */
  readonly failures: readonly ParallelFailure[]

  /** Creates an aggregate branch error without replacing the original causes. */
  constructor(failures: readonly ParallelFailure[]) {
    const branches = failures.map(failure => failure.branchIndex + 1).join(", ")
    super(failures.length === 1 ? `<Parallel> branch ${branches} failed` : `<Parallel> branches ${branches} failed`)
    this.name = "ParallelError"
    this.failures = failures
  }
}

/**
 * Evaluates each flattened child concurrently and renders successful outputs
 * in authored order after every branch has settled.
 *
 * Completion order never changes the result order. The component waits for all
 * branch cleanup and then throws one `ParallelError` when any branch failed;
 * successful side effects are not rolled back.
 */
export async function Parallel({ children }: ParallelProps): Promise<readonly string[]> {
  const branches = flattenBranches(children)
  const settled = await Promise.allSettled(branches.map(branch => evaluate(branch)))
  const failures: ParallelFailure[] = []
  const output: string[] = []

  for (const [branchIndex, result] of settled.entries()) {
    if (result.status === "rejected") {
      failures.push({ branchIndex, cause: result.reason })
    } else {
      output.push(result.value)
    }
  }

  if (failures.length > 0) {
    throw new ParallelError(failures)
  }

  return output
}

/** Flattens JSX child arrays while retaining fragments as explicit groups. */
function flattenBranches(children: AmlRenderable): AmlRenderable[] {
  const activeArrays = new Set<readonly AmlRenderable[]>()
  const branches: AmlRenderable[] = []

  function visit(value: AmlRenderable): void {
    if (Array.isArray(value)) {
      if (activeArrays.has(value)) {
        throw new EvaluationError("AML arrays cannot contain cycles")
      }

      activeArrays.add(value)

      for (const child of value) {
        visit(child)
      }

      activeArrays.delete(value)
      return
    }

    if (value === null || value === undefined || typeof value === "boolean") {
      return
    }

    branches.push(value)
  }

  visit(children)
  return branches
}
