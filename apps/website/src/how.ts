/**
 * "How it works": a five-step walkthrough of leaves-first resolution on the
 * review tree. Steps auto-advance until the reader takes over manually.
 */

import { highlightTsx } from "./highlight"

type NodeState = "idle" | "resolving" | "running" | "done"

interface HowStep {
  title: string
  body: string
  caption: string
  nodes: Record<string, NodeState>
  /** node ids that get a numeric order badge */
  badges: Record<string, string>
  hotEdges: readonly string[]
  doneEdges: readonly string[]
}

interface HowNode {
  id: string
  label: string
  x: number
  y: number
}

// Inverted triangle: leaves on top, <Review /> root at the bottom.
const NODES: readonly HowNode[] = [
  { id: "tool", label: "<Tool> read_source", x: 150, y: 34 },
  { id: "prompt", label: '"Review src/index.ts."', x: 415, y: 34 },
  { id: "spec-a", label: "<Agent> correctness", x: 150, y: 112 },
  { id: "spec-b", label: "<Agent> maintainability", x: 415, y: 112 },
  { id: "synth", label: "<Agent> synthesize", x: 280, y: 208 },
  { id: "root", label: "<Review />", x: 280, y: 298 },
]

const EDGES: ReadonlyArray<readonly [string, string, string]> = [
  ["e-root", "root", "synth"],
  ["e-a", "synth", "spec-a"],
  ["e-b", "synth", "spec-b"],
  ["e-tool", "spec-a", "tool"],
  ["e-prompt", "spec-b", "prompt"],
]

const IDLE_ALL: Record<string, NodeState> = {
  root: "idle",
  synth: "idle",
  "spec-a": "idle",
  "spec-b": "idle",
  tool: "idle",
  prompt: "idle",
}

const STEPS: readonly HowStep[] = [
  {
    title: "Resolve components and context",
    body: "Ordinary async components and JSX children resolve first, in authored order. Nothing has run a model yet.",
    caption: "children first — <Tool> grants and prompt text resolve before any session starts",
    nodes: { ...IDLE_ALL, tool: "done", prompt: "done", "spec-a": "resolving", "spec-b": "resolving" },
    badges: { tool: "1", prompt: "2" },
    hotEdges: ["e-tool", "e-prompt"],
    doneEdges: [],
  },
  {
    title: "Start independent work explicitly",
    body: "Promise.all() starts both specialist sessions concurrently. Concurrency is ordinary JavaScript — never hidden runtime magic.",
    caption: "each specialist holds its own provider-owned session",
    nodes: { ...IDLE_ALL, tool: "done", prompt: "done", "spec-a": "running", "spec-b": "running" },
    badges: { tool: "1", prompt: "2" },
    hotEdges: ["e-a", "e-b"],
    doneEdges: ["e-tool", "e-prompt"],
  },
  {
    title: "Authored order is preserved",
    body: "The specialists finish out of order. Their results still land in the destructured [correctness, maintainability] positions.",
    caption: "out-of-order completion, in-order dataflow",
    nodes: { ...IDLE_ALL, tool: "done", prompt: "done", "spec-b": "done", "spec-a": "running" },
    badges: { tool: "1", prompt: "2", "spec-b": "3" },
    hotEdges: ["e-a"],
    doneEdges: ["e-tool", "e-prompt", "e-b"],
  },
  {
    title: "Results carry into parent prompts",
    body: "Child Agent outputs become prompt content for the synthesizer — typed values flowing through ordinary JSX interpolation.",
    caption: 'system: "Synthesize evidence without inventing findings."',
    nodes: { ...IDLE_ALL, tool: "done", prompt: "done", "spec-a": "done", "spec-b": "done", synth: "running" },
    badges: { tool: "1", prompt: "2", "spec-b": "3", "spec-a": "4" },
    hotEdges: ["e-root"],
    doneEdges: ["e-tool", "e-prompt", "e-a", "e-b"],
  },
  {
    title: "Return the final output",
    body: "Leases release, trace events flush, and the root resolves to text — or schema-validated structured data via evaluate().",
    caption: "evaluation:end → final string returned to the caller",
    nodes: { root: "done", synth: "done", "spec-a": "done", "spec-b": "done", tool: "done", prompt: "done" },
    badges: { tool: "1", prompt: "2", "spec-b": "3", "spec-a": "4", synth: "5", root: "✓" },
    hotEdges: [],
    doneEdges: ["e-root", "e-a", "e-b", "e-tool", "e-prompt"],
  },
]

const SVG_NS = "http://www.w3.org/2000/svg"

const REVIEW_SOURCE = `import { Agent, evaluate, System, Tool } from "@aml/sdk"

async function Review() {
  const [correctness, maintainability] = await Promise.all([
    evaluate(
      <Agent provider={OpenCode}>
        <Tool use={ReadSource} />
        Review src/index.ts for correctness defects.
      </Agent>,
    ),
    evaluate(
      <Agent provider={OpenCode}>
        Review src/index.ts for maintainability issues.
      </Agent>,
    ),
  ])

  return (
    <Agent provider={OpenCode}>
      <System>Synthesize evidence without inventing findings.</System>
      Correctness: {correctness}
      Maintainability: {maintainability}
      Produce the final review.
    </Agent>
  )
}

const result = await runtime.evaluate(<Review />)`

export async function initHow(): Promise<void> {
  const queriedList = document.querySelector<HTMLOListElement>("#how-steps")
  const queriedSvg = document.querySelector<SVGSVGElement>("#how-tree")
  const queriedCaption = document.querySelector<HTMLElement>("#how-caption")
  const queriedReplay = document.querySelector<HTMLButtonElement>("#how-replay")
  const queriedCard = document.querySelector<HTMLElement>("#how-card-inner")
  const queriedVisualFace = document.querySelector<HTMLElement>("#how-visual-face")
  const queriedSourceFace = document.querySelector<HTMLElement>("#how-source-face")
  const queriedVisualButton = document.querySelector<HTMLButtonElement>("#how-view-visual")
  const queriedSourceButton = document.querySelector<HTMLButtonElement>("#how-view-source")
  const queriedSource = document.querySelector<HTMLElement>("#how-source")
  if (
    !queriedList ||
    !queriedSvg ||
    !queriedCaption ||
    !queriedReplay ||
    !queriedCard ||
    !queriedVisualFace ||
    !queriedSourceFace ||
    !queriedVisualButton ||
    !queriedSourceButton ||
    !queriedSource
  ) return
  // Aliased so nested closures keep the non-null types.
  const list = queriedList
  const svg = queriedSvg
  const caption = queriedCaption
  const replay = queriedReplay
  const card = queriedCard
  const visualFace = queriedVisualFace
  const sourceFace = queriedSourceFace
  const visualButton = queriedVisualButton
  const sourceButton = queriedSourceButton

  queriedSource.innerHTML = await highlightTsx(REVIEW_SOURCE)

  // Build the SVG tree once; steps only flip state attributes.
  const nodeById = new Map(NODES.map((node) => [node.id, node]))

  for (const [edgeId, from, to] of EDGES) {
    const a = nodeById.get(from)!
    const b = nodeById.get(to)!
    const line = document.createElementNS(SVG_NS, "line")
    line.setAttribute("x1", String(a.x))
    line.setAttribute("y1", String(a.y))
    line.setAttribute("x2", String(b.x))
    line.setAttribute("y2", String(b.y))
    line.setAttribute("class", "pg-edge")
    line.dataset.edge = edgeId
    svg.append(line)
  }

  const groups = new Map<string, SVGGElement>()
  const badgeByNode = new Map<string, SVGGElement>()

  for (const node of NODES) {
    const width = node.label.length * 6.7 + 20
    const group = document.createElementNS(SVG_NS, "g")
    group.setAttribute("class", "pg-node")
    group.dataset.state = "idle"

    const halo = document.createElementNS(SVG_NS, "rect")
    halo.setAttribute("class", "node-halo")
    halo.setAttribute("x", String(node.x - width / 2))
    halo.setAttribute("y", String(node.y - 15))
    halo.setAttribute("width", String(width))
    halo.setAttribute("height", "30")
    halo.setAttribute("rx", "9")

    const box = halo.cloneNode() as SVGRectElement
    box.setAttribute("class", "node-box")

    const text = document.createElementNS(SVG_NS, "text")
    text.setAttribute("x", String(node.x))
    text.setAttribute("y", String(node.y + 3.5))
    text.setAttribute("text-anchor", "middle")
    text.setAttribute(
      "style",
      "font: 600 10.5px 'IBM Plex Mono', monospace; fill: var(--color-ink-soft)",
    )
    text.textContent = node.label

    const badge = document.createElementNS(SVG_NS, "g")
    badge.setAttribute("opacity", "0")
    const badgeCircle = document.createElementNS(SVG_NS, "circle")
    badgeCircle.setAttribute("cx", String(node.x - width / 2))
    badgeCircle.setAttribute("cy", String(node.y - 15))
    badgeCircle.setAttribute("r", "8")
    badgeCircle.setAttribute("fill", "var(--color-resolve)")
    const badgeText = document.createElementNS(SVG_NS, "text")
    badgeText.setAttribute("x", String(node.x - width / 2))
    badgeText.setAttribute("y", String(node.y - 11.5))
    badgeText.setAttribute("text-anchor", "middle")
    badgeText.setAttribute("style", "font: 700 9px 'IBM Plex Mono', monospace; fill: #fff")
    badge.append(badgeCircle, badgeText)
    badgeByNode.set(node.id, badge)

    group.append(halo, box, text, badge)
    svg.append(group)
    groups.set(node.id, group)
  }

  // Step buttons.
  const buttons: HTMLButtonElement[] = STEPS.map((step, index) => {
    const item = document.createElement("li")
    const button = document.createElement("button")
    button.className =
      "group w-full rounded-xl border border-line bg-paper px-5 py-4 text-left transition-all hover:border-line-strong"
    button.innerHTML = `
      <span class="grid grid-cols-[auto_1fr] items-center gap-4">
        <span class="step-index grid size-7 place-items-center rounded-full border border-line-strong font-mono text-[12px] font-semibold transition-colors">${index + 1}</span>
        <span class="block border-l border-line-strong pl-4">
          <span class="block font-semibold text-[15px]">${step.title}</span>
          <span class="step-body mt-2 hidden text-[13.5px] leading-relaxed text-ink-soft">${step.body}</span>
        </span>
      </span>`
    item.append(button)
    list.append(item)
    return button
  })

  let active = -1
  let timer = 0
  let auto = true
  let sourceViewed = false

  function show(index: number): void {
    if (index === active) return
    active = index
    const step = STEPS[index]!
    // Auto-advance re-arms from here so manual clicks (which clear `auto`)
    // stop the chain without a separate scheduler path.

    for (const [id, group] of groups) {
      group.dataset.state = step.nodes[id] ?? "idle"
    }
    for (const [id, badge] of badgeByNode) {
      const value = step.badges[id]
      badge.setAttribute("opacity", value === undefined ? "0" : "1")
      if (value !== undefined) {
        ;(badge.lastChild as SVGTextElement).textContent = value
      }
    }
    svg.querySelectorAll<SVGLineElement>("[data-edge]").forEach((edge) => {
      const id = edge.dataset.edge ?? ""
      edge.classList.toggle("is-hot", step.hotEdges.includes(id))
      edge.classList.toggle("is-done", step.doneEdges.includes(id))
    })

    caption.textContent = `// ${step.caption}`

    buttons.forEach((button, buttonIndex) => {
      const isActive = buttonIndex === index
      // Swap (never stack) conflicting background/border utilities — see pg tabs.
      button.classList.toggle("border-resolve", isActive)
      button.classList.toggle("bg-resolve-soft/40", isActive)
      button.classList.toggle("shadow-sm", isActive)
      button.classList.toggle("border-line", !isActive)
      button.classList.toggle("bg-paper", !isActive)
      button.querySelector(".step-body")?.classList.toggle("hidden", !isActive)
      const chip = button.querySelector(".step-index")
      chip?.classList.toggle("bg-resolve", isActive)
      chip?.classList.toggle("border-resolve", isActive)
      chip?.classList.toggle("text-white", isActive)
    })

    window.clearTimeout(timer)
    if (auto) {
      timer = window.setTimeout(() => show((active + 1) % STEPS.length), 3200)
    }
    if (activeView === "visual") requestAnimationFrame(syncCardHeight)
  }

  buttons.forEach((button, index) => {
    button.addEventListener("click", () => {
      auto = false
      window.clearTimeout(timer)
      show(index)
    })
  })

  replay.addEventListener("click", () => {
    auto = true
    active = -1
    show(0)
  })

  let activeView: "visual" | "source" = "visual"

  function syncCardHeight(): void {
    const activeFace = activeView === "source" ? sourceFace : visualFace
    card.style.height = `${activeFace.offsetHeight}px`
  }

  function setView(view: "visual" | "source"): void {
    const showSource = view === "source"
    activeView = view
    card.classList.toggle("is-source", showSource)
    visualFace.setAttribute("aria-hidden", String(showSource))
    sourceFace.setAttribute("aria-hidden", String(!showSource))
    visualFace.inert = showSource
    sourceFace.inert = !showSource
    visualButton.setAttribute("aria-selected", String(!showSource))
    sourceButton.setAttribute("aria-selected", String(showSource))
    visualButton.classList.toggle("bg-ink", !showSource)
    visualButton.classList.toggle("text-paper", !showSource)
    visualButton.classList.toggle("text-muted", showSource)
    sourceButton.classList.toggle("bg-ink", showSource)
    sourceButton.classList.toggle("text-paper", showSource)
    sourceButton.classList.toggle("text-muted", !showSource)
    if (showSource) {
      auto = false
      window.clearTimeout(timer)
    }
    requestAnimationFrame(syncCardHeight)
  }

  visualButton.addEventListener("click", () => setView("visual"))
  sourceButton.addEventListener("click", () => {
    if (!sourceViewed) {
      sourceViewed = true
      sourceButton.classList.remove("source-attention")
    }
    setView("source")
  })
  setView("visual")
  window.addEventListener("resize", syncCardHeight)
  void document.fonts.ready.then(syncCardHeight)

  // Start when scrolled into view.
  new IntersectionObserver(
    ([entry], observer) => {
      if (entry?.isIntersecting) {
        observer.disconnect()
        show(0)
      }
    },
    { threshold: 0.3 },
  ).observe(svg)
}
