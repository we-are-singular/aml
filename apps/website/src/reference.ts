import { CONCEPTS, type Concept } from "./concepts"
import { withBase } from "./config/site"
import { highlightTsx } from "./highlight"

/**
 * Reference section: a sticky tree index driving a detail panel. Selection
 * syncs to the URL hash so entries are linkable.
 */
export async function initReference(): Promise<void> {
  const list = document.querySelector<HTMLElement>("#ref-list")
  if (!list) return

  // All detail-panel elements are static siblings of #ref-list in index.html.
  const name = document.querySelector<HTMLElement>("#ref-name")!
  const kind = document.querySelector<HTMLElement>("#ref-kind")!
  const signature = document.querySelector<HTMLElement>("#ref-signature")!
  const description = document.querySelector<HTMLElement>("#ref-description")!
  const note = document.querySelector<HTMLElement>("#ref-note")!
  const example = document.querySelector<HTMLElement>("#ref-example")!
  const exampleFile = document.querySelector<HTMLElement>("#ref-example-file")!
  const docsLink = document.querySelector<HTMLAnchorElement>("#ref-docs")!
  const copy = document.querySelector<HTMLButtonElement>("#ref-copy")!

  const buttons = new Map<string, HTMLButtonElement>()
  const groups = ["Concepts", "Components", "Runtime APIs"] as const

  for (const group of groups) {
    const concepts = CONCEPTS.filter(concept => concept.group === group)
    const section = document.createElement("div")
    section.className = "ref-tree-group"
    section.setAttribute("role", "group")
    section.innerHTML = `
      <p class="ref-tree-label mb-2 flex items-center justify-between font-mono text-[11px] uppercase tracking-wider text-muted">
        ${group}
        <span class="rounded-full border border-line px-1.5 text-[10px]">${concepts.length}</span>
      </p>`
    const stack = document.createElement("div")
    stack.className = "ref-tree-stack flex flex-col gap-1"

    for (const concept of concepts) {
      const button = document.createElement("button")
      button.className =
        "ref-item relative w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-left font-mono text-[12.5px] transition-all hover:border-line-strong"
      button.setAttribute("role", "treeitem")
      button.textContent = concept.name
      button.addEventListener("click", () => void select(concept, true))
      buttons.set(concept.id, button)
      stack.append(button)
    }

    section.append(stack)
    list.append(section)
  }

  async function select(concept: Concept, updateHash: boolean): Promise<void> {
    name.textContent = concept.name
    kind.textContent =
      concept.group === "Concepts" ? "concept" : concept.group === "Components" ? "component" : "runtime api"
    signature.textContent = concept.signature
    description.textContent = concept.description
    if (concept.note) {
      note.textContent = concept.note
      note.classList.remove("hidden")
    } else {
      note.classList.add("hidden")
    }
    exampleFile.textContent = concept.file
    example.innerHTML = await highlightTsx(concept.code)
    if (concept.docsPath) {
      docsLink.href = withBase(concept.docsPath)
      docsLink.textContent = `Read the ${concept.name} reference →`
      docsLink.classList.remove("hidden")
    } else {
      docsLink.classList.add("hidden")
    }

    for (const [id, button] of buttons) {
      const isActive = id === concept.id
      // Swap (never stack) conflicting background/border utilities — see pg tabs.
      button.classList.toggle("border-resolve", isActive)
      button.classList.toggle("bg-resolve-soft", isActive)
      button.classList.toggle("text-resolve", isActive)
      button.classList.toggle("font-semibold", isActive)
      button.classList.toggle("bg-surface", !isActive)
      button.classList.toggle("border-line", !isActive)
    }

    if (updateHash) {
      history.replaceState(null, "", `#ref-${concept.id}`)
    }
  }

  copy.addEventListener("click", async () => {
    const active = [...buttons.entries()].find(([, button]) => button.classList.contains("border-resolve"))
    const concept = CONCEPTS.find(candidate => candidate.id === active?.[0])
    if (!concept) return
    await navigator.clipboard.writeText(concept.code)
    copy.textContent = "copied ✓"
    window.setTimeout(() => (copy.textContent = "copy"), 1200)
  })

  const fromHash = CONCEPTS.find(concept => location.hash === `#ref-${concept.id}`)
  await select(fromHash ?? CONCEPTS[0]!, false)
}
