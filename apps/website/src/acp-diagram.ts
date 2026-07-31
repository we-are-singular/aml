/**
 * Renders the ACP architecture study in the same deliberate SVG language as
 * the leaves-first walkthrough. Desktop and mobile use separate coordinates
 * so the Runtime fork stays legible instead of shrinking into a wide graph.
 */

type Tone = "agent" | "ink" | "ok" | "resolve" | "signal"

interface DiagramNode {
  readonly detail: string
  readonly id: string
  readonly pills?: readonly { readonly label: string; readonly tone: "agent" | "ink" | "ok" }[]
  readonly title: string
  readonly tone: Tone
}

interface NodeFrame {
  readonly height: number
  readonly width: number
  readonly x: number
  readonly y: number
}

interface DiagramEdge {
  readonly path: string
  readonly tone: Tone
}

interface DiagramLayout {
  readonly edges: readonly DiagramEdge[]
  readonly frames: Readonly<Record<string, NodeFrame>>
  readonly viewBox: string
}

const SVG_NS = "http://www.w3.org/2000/svg"

const NODES: readonly DiagramNode[] = [
  { detail: "main.tsx", id: "app", title: "YOUR APP", tone: "ink" },
  { detail: "plans, runs, and observes", id: "runtime", title: "AML RUNTIME", tone: "resolve" },
  { detail: "Wraps any Agent SDK", id: "profile", title: "AGENT PROVIDER", tone: "agent" },
  { detail: "shared ACP session", id: "engine", title: "ACP ENGINE", tone: "resolve" },
  { detail: "durable object storage", id: "workspace", title: "WORKSPACE PROVIDER", tone: "ok" },
  {
    detail: "isolated remote execution",
    id: "sandbox",
    pills: [
      { label: "AGENT PROCESS", tone: "agent" },
      { label: "WORKSPACE FILES", tone: "ok" },
    ],
    title: "SANDBOX ADAPTER",
    tone: "signal",
  },
]

const DESKTOP_LAYOUT: DiagramLayout = {
  viewBox: "0 0 1080 390",
  frames: {
    app: { x: 20, y: 165, width: 130, height: 60 },
    runtime: { x: 200, y: 160, width: 160, height: 70 },
    profile: { x: 430, y: 50, width: 165, height: 70 },
    engine: { x: 660, y: 50, width: 165, height: 70 },
    workspace: { x: 430, y: 270, width: 165, height: 70 },
    sandbox: { x: 860, y: 130, width: 200, height: 150 },
  },
  edges: [
    { path: "M85 195 H280", tone: "ink" },
    { path: "M280 195 H402.5 L512.5 85", tone: "agent" },
    { path: "M280 195 H402.5 L512.5 305", tone: "ok" },
    { path: "M512.5 85 H742.5", tone: "resolve" },
    { path: "M742.5 85 H840 L960 205", tone: "resolve" },
    { path: "M512.5 305 H860 L960 205", tone: "ok" },
  ],
}

const MOBILE_LAYOUT: DiagramLayout = {
  viewBox: "0 0 360 720",
  frames: {
    app: { x: 100, y: 20, width: 160, height: 58 },
    runtime: { x: 95, y: 110, width: 170, height: 66 },
    profile: { x: 15, y: 260, width: 150, height: 70 },
    engine: { x: 15, y: 380, width: 150, height: 70 },
    workspace: { x: 195, y: 260, width: 150, height: 70 },
    sandbox: { x: 85, y: 540, width: 190, height: 150 },
  },
  edges: [
    { path: "M180 49 V143", tone: "ink" },
    { path: "M180 143 V205 L90 295", tone: "agent" },
    { path: "M180 143 V205 L270 295", tone: "ok" },
    { path: "M90 295 V415", tone: "resolve" },
    { path: "M90 415 V525 L180 615", tone: "resolve" },
    { path: "M270 295 V525 L180 615", tone: "ok" },
  ],
}

export function initAcpDiagram(): void {
  const svg = document.querySelector<SVGSVGElement>("#acp-runtime-map")
  if (!svg) return

  const mobile = window.matchMedia("(max-width: 767px)")

  const render = (): void => {
    const layout = mobile.matches ? MOBILE_LAYOUT : DESKTOP_LAYOUT
    svg.replaceChildren()
    svg.setAttribute("viewBox", layout.viewBox)

    for (const edge of layout.edges) {
      svg.append(createEdge(edge))
    }

    for (const node of NODES) {
      const frame = layout.frames[node.id]
      if (frame) svg.append(createNode(node, frame))
    }
  }

  render()
  mobile.addEventListener("change", render)
}

function createEdge(edge: DiagramEdge): SVGGElement {
  const group = createSvg("g")
  const path = createSvg("path")
  path.setAttribute("class", "acp-map-edge")
  path.setAttribute("d", edge.path)
  path.dataset.tone = edge.tone
  group.append(path)

  return group
}

function createNode(node: DiagramNode, frame: NodeFrame): SVGGElement {
  const group = createSvg("g")
  group.setAttribute("class", "acp-map-node")
  group.dataset.tone = node.tone

  const box = createSvg("rect")
  box.setAttribute("class", "acp-map-node-box")
  box.setAttribute("x", String(frame.x))
  box.setAttribute("y", String(frame.y))
  box.setAttribute("width", String(frame.width))
  box.setAttribute("height", String(frame.height))
  box.setAttribute("rx", "12")

  const title = createSvg("text")
  title.setAttribute("class", "acp-map-title")
  title.setAttribute("x", String(frame.x + 14))
  title.setAttribute("y", String(frame.y + 25))
  title.textContent = node.title

  group.append(box, title)

  if (node.detail) {
    const detail = createSvg("text")
    detail.setAttribute("class", "acp-map-detail")
    detail.setAttribute("x", String(frame.x + 14))
    detail.setAttribute("y", String(frame.y + 46))
    detail.textContent = node.detail
    group.append(detail)
  }

  node.pills?.forEach((pill, index) => {
    const pillWidth = pill.label.length * 5.8 + 18
    const x = frame.x + 14
    const y = frame.y + 68 + index * 31
    const pillBox = createSvg("rect")
    pillBox.setAttribute("class", "acp-map-pill")
    pillBox.dataset.tone = pill.tone
    pillBox.setAttribute("x", String(x))
    pillBox.setAttribute("y", String(y))
    pillBox.setAttribute("width", String(pillWidth))
    pillBox.setAttribute("height", "23")
    pillBox.setAttribute("rx", "6")

    const pillText = createSvg("text")
    pillText.setAttribute("class", "acp-map-pill-text")
    pillText.setAttribute("x", String(x + 9))
    pillText.setAttribute("y", String(y + 15.5))
    pillText.textContent = pill.label
    group.append(pillBox, pillText)
  })

  return group
}

function createSvg<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag)
}
