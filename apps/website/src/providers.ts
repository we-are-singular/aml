import { highlightLines } from "./highlight"

/**
 * Runtime packages demo: one fixed Agent tree shown against every built-in
 * Agent × Sandbox combination. Picking either adapter re-renders the
 * configured construction while the tree stays provider-agnostic.
 */

interface AgentOption {
  id: string
  label: string
  fn: string
  construction: string
}

interface SandboxOption {
  id: string
  label: string
  fn: string
  construction: string
}

const AGENTS: readonly AgentOption[] = [
  {
    id: "opencode",
    label: "OpenCode",
    fn: "opencodeAgent",
    construction: `opencodeAgent({ model: "opencode-go/glm-5.1" })`,
  },
  {
    id: "codex",
    label: "Codex",
    fn: "codexAgent",
    construction: `codexAgent({ model: "gpt-5.3-codex" })`,
  },
  {
    id: "pi",
    label: "Pi",
    fn: "piAgent",
    construction: `piAgent({ model: "opencode-go/glm-5.1" })`,
  },
]

const SANDBOXES: readonly SandboxOption[] = [
  {
    id: "local",
    label: "Local",
    fn: "localSandbox",
    construction: `localSandbox({ workspace: "./project" })`,
  },
  {
    id: "docker",
    label: "Docker",
    fn: "dockerSandbox",
    construction: `dockerSandbox({ image: "node:26" })`,
  },
  {
    id: "daytona",
    label: "Daytona",
    fn: "daytonaSandbox",
    construction: `daytonaSandbox({ image: "node:26", workspace: "./project" })`,
  },
  {
    id: "modal",
    label: "Modal",
    fn: "modalSandbox",
    construction: `modalSandbox({ create: { cpu: 2  }, image: "node:26" })`,
  },
]

/** Lines pinned as "the ones that change": import, provider, sandbox. */
const PINNED_LINES: readonly number[] = [1, 3, 4]
/** Lines touched when only the Agent selection changes. */
const AGENT_LINES: readonly number[] = [1, 3]
/** Lines touched when only the Sandbox selection changes. */
const SANDBOX_LINES: readonly number[] = [1, 4]

function compose(agent: AgentOption, sandbox: SandboxOption): string {
  const providers = [agent.fn, sandbox.fn].sort().join(", ")
  return `import { Agent, AmlRuntime, Sandbox, ${providers} } from "@aml-jsx/sdk"

const provider = ${agent.construction}
const sandbox = ${sandbox.construction}
const runtime = new AmlRuntime()

await runtime.evaluate(
  <Sandbox provider={sandbox}>
    <Agent provider={provider}>Summarize this repository.</Agent>
  </Sandbox>,
)`
}

export async function initProviders(): Promise<void> {
  const agentGroup = document.querySelector<HTMLElement>("#pick-agent")
  const sandboxGroup = document.querySelector<HTMLElement>("#pick-sandbox")
  const name = document.querySelector<HTMLElement>("#combo-name")
  const code = document.querySelector<HTMLElement>("#combo-code")
  const copy = document.querySelector<HTMLButtonElement>("#combo-copy")
  if (!agentGroup || !sandboxGroup || !name || !code) return

  let agentId = "opencode"
  let sandboxId = "local"
  // Rapid clicks resolve out of order; only the latest render may paint.
  let renderToken = 0

  const agent = (): AgentOption => AGENTS.find(option => option.id === agentId) ?? AGENTS[0]!
  const sandbox = (): SandboxOption => SANDBOXES.find(option => option.id === sandboxId) ?? SANDBOXES[0]!

  async function render(changed: readonly number[]): Promise<void> {
    const token = ++renderToken
    const html = await highlightLines(compose(agent(), sandbox()))
    if (token !== renderToken || !name || !code) return

    name.textContent = `${agent().label} × ${sandbox().label}`
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
    await navigator.clipboard.writeText(compose(agent(), sandbox()))
    copy.textContent = "copied ✓"
    window.setTimeout(() => (copy.textContent = "copy"), 1200)
  })

  await render([])
}
