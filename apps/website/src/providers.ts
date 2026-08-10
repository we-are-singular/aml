import { highlightLines } from "./highlight"
import {
  agentOptions as AGENTS,
  composeProviderExample,
  sandboxOptions as SANDBOXES,
  workspaceOptions as WORKSPACES,
  type AgentOption,
  type SandboxOption,
  type WorkspaceOption,
} from "./data/provider-catalog"

/**
 * Runtime packages demo: one fixed Agent tree shown against every built-in
 * Agent × Sandbox × Workspace combination. Picking any adapter re-renders the
 * configured construction while the tree stays provider-agnostic.
 */

/** Lines pinned as "the ones that change": provider imports, constructions, and Workspace policy. */
const PINNED_LINES: readonly number[] = [3, 4, 5, 8, 9, 10, 14]
/** Lines touched when only the Agent selection changes. */
const AGENT_LINES: readonly number[] = [3, 8]
/** Lines touched when only the Sandbox selection changes. */
const SANDBOX_LINES: readonly number[] = [4, 9]
/** Lines touched when only the Workspace selection changes. */
const WORKSPACE_LINES: readonly number[] = [5, 10, 14]

export async function initProviders(): Promise<void> {
  const agentGroup = document.querySelector<HTMLElement>("#pick-agent")
  const sandboxGroup = document.querySelector<HTMLElement>("#pick-sandbox")
  const workspaceGroup = document.querySelector<HTMLElement>("#pick-workspace")
  const name = document.querySelector<HTMLElement>("#combo-name")
  const code = document.querySelector<HTMLElement>("#combo-code")
  const copy = document.querySelector<HTMLButtonElement>("#combo-copy")
  if (!agentGroup || !sandboxGroup || !workspaceGroup || !name || !code) return

  let agentId = "opencode"
  let sandboxId = "local"
  let workspaceId = "workspace-s3"
  // Rapid clicks resolve out of order; only the latest render may paint.
  let renderToken = 0

  const agent = (): AgentOption => AGENTS.find(option => option.id === agentId) ?? AGENTS[0]!
  const sandbox = (): SandboxOption => SANDBOXES.find(option => option.id === sandboxId) ?? SANDBOXES[0]!
  const workspace = (): WorkspaceOption => WORKSPACES.find(option => option.id === workspaceId) ?? WORKSPACES[0]!

  async function render(changed: readonly number[]): Promise<void> {
    const token = ++renderToken
    const html = await highlightLines(composeProviderExample(agent(), sandbox(), workspace()))
    if (token !== renderToken || !name || !code) return

    name.textContent = `${agent().label} × ${sandbox().label} × ${workspace().label}`
    code.innerHTML = html

    for (const line of code.querySelectorAll<HTMLElement>(".code-line")) {
      const lineNumber = Number(line.dataset.line)
      if (PINNED_LINES.includes(lineNumber)) line.classList.add("is-active")
      if (changed.includes(lineNumber)) {
        line.classList.add("flash")
        line.addEventListener("animationend", () => line.classList.remove("flash"), { once: true })
      }
    }
  }

  function syncRows(group: HTMLElement, selectedId: string): void {
    group.querySelectorAll<HTMLButtonElement>("[data-pick]").forEach(row => {
      const isActive = row.dataset.pick === selectedId
      row.classList.toggle("is-active", isActive)
      row.setAttribute("aria-checked", String(isActive))
    })
  }

  function wireGroup(group: HTMLElement, ids: readonly string[], select: (id: string) => void): void {
    group.querySelectorAll<HTMLButtonElement>("[data-pick]").forEach(row => {
      row.addEventListener("click", () => {
        if (row.dataset.pick) select(row.dataset.pick)
      })
    })

    // role=radiogroup implies arrow-key movement between the rows.
    group.addEventListener("keydown", event => {
      if (!(event.target instanceof HTMLButtonElement)) return
      const index = ids.indexOf(event.target.dataset.pick ?? "")
      const delta = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : 0
      const step = delta || (event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0)
      if (index === -1 || step === 0) return
      event.preventDefault()
      const next = ids[(index + step + ids.length) % ids.length]!
      select(next)
      group.querySelector<HTMLButtonElement>(`[data-pick="${next}"]`)?.focus()
    })
  }

  wireGroup(
    agentGroup,
    AGENTS.map(option => option.id),
    id => {
      if (id === agentId) return
      agentId = id
      syncRows(agentGroup, id)
      void render(AGENT_LINES)
    }
  )
  wireGroup(
    workspaceGroup,
    WORKSPACES.map(option => option.id),
    id => {
      if (id === workspaceId) return
      workspaceId = id
      syncRows(workspaceGroup, id)
      void render(WORKSPACE_LINES)
    }
  )
  wireGroup(
    sandboxGroup,
    SANDBOXES.map(option => option.id),
    id => {
      if (id === sandboxId) return
      sandboxId = id
      syncRows(sandboxGroup, id)
      void render(SANDBOX_LINES)
    }
  )

  // Copies the data model rather than the DOM so no highlight markup leaks in.
  copy?.addEventListener("click", async () => {
    if (!copy) return
    await navigator.clipboard.writeText(composeProviderExample(agent(), sandbox(), workspace()))
    copy.textContent = "copied ✓"
    window.setTimeout(() => (copy.textContent = "copy"), 1200)
  })

  await render([])
}
