import { CONCEPTS, type Concept } from "./concepts"
import { withBase } from "./config/site"
import { highlightTsx } from "./highlight"

/** Connects the desktop index and mobile selector to one linkable reference preview. */
export async function initReference(): Promise<void> {
  const list = document.querySelector<HTMLElement>("#ref-list")
  if (!list) return

  const picker = document.querySelector<HTMLSelectElement>("#ref-select")!
  const name = document.querySelector<HTMLElement>("#ref-name")!
  const kind = document.querySelector<HTMLElement>("#ref-kind")!
  const description = document.querySelector<HTMLElement>("#ref-description")!
  const warning = document.querySelector<HTMLElement>("#ref-warning")!
  const example = document.querySelector<HTMLElement>("#ref-example code")!
  const exampleFile = document.querySelector<HTMLElement>("#ref-example-file")!
  const docsLink = document.querySelector<HTMLAnchorElement>("#ref-docs")!
  const copy = document.querySelector<HTMLButtonElement>("#ref-copy")!
  const buttons = [...list.querySelectorAll<HTMLButtonElement>("[data-ref-id]")]
  let selected = CONCEPTS[0]!

  async function select(concept: Concept, updateHash: boolean): Promise<void> {
    selected = concept
    picker.value = concept.id
    name.textContent = concept.name
    kind.textContent =
      concept.group === "Concepts"
        ? "concept"
        : concept.group === "Components"
          ? "component"
          : concept.id === "aml"
            ? "type"
            : "runtime api"
    description.textContent = concept.description
    warning.textContent = concept.warning ?? ""
    warning.hidden = concept.warning === undefined
    exampleFile.textContent = concept.file
    docsLink.href = withBase(concept.docsPath)
    docsLink.setAttribute("aria-label", `Read the full ${concept.name} guide`)

    for (const button of buttons) {
      const active = button.dataset.refId === concept.id
      button.classList.toggle("is-active", active)
      button.setAttribute("aria-pressed", String(active))
    }

    if (updateHash) history.replaceState(null, "", `#ref-${concept.id}`)

    const highlighted = await highlightTsx(concept.code)
    // A slower highlight must not replace a newer selection's example.
    if (selected.id === concept.id) example.innerHTML = highlighted
  }

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const concept = CONCEPTS.find(candidate => candidate.id === button.dataset.refId)
      if (concept) void select(concept, true)
    })
  }

  picker.addEventListener("change", () => {
    const concept = CONCEPTS.find(candidate => candidate.id === picker.value)
    if (concept) void select(concept, true)
  })

  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(selected.code)
    copy.textContent = "copied ✓"
    window.setTimeout(() => (copy.textContent = "copy"), 1200)
  })

  const fromHash = CONCEPTS.find(concept => location.hash === `#ref-${concept.id}`)
  await select(fromHash ?? selected, false)
  if (fromHash) document.querySelector("#reference")?.scrollIntoView({ block: "start" })
}
