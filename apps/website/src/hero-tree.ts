/**
 * Hero canvas: loops one evaluation of the weekly standup workflow — its
 * gatherers run concurrently and finish out of order,
 * results flow down into the synthesizer, and the root emits the output.
 *
 * The tree is drawn as an inverted triangle: leaves at the top, root at the
 * bottom, so resolution reads in the same direction as the page.
 */

type NodeState = "idle" | "resolving" | "running" | "done"

interface HeroNode {
  id: string
  x: number
  y: number
}

interface Particle {
  edge: [string, string]
  from: number
  to: number
}

const INK = "#1a1914"
const MUTED = "#a39e8e"
const LINE = "#d4d0c2"
const RESOLVE = "#2e4bff"
const RESOLVE_SOFT = "#e6ebff"
const SIGNAL = "#ff5a1f"
const SIGNAL_SOFT = "#ffe9df"
const OK = "#0f9d6c"
const OK_SOFT = "#ddf5ea"

const GATHERERS = ["linear", "slack"] as const

const CYCLE_MS = 9000

/** State of every node as a pure function of time within one cycle. */
function stateAt(t: number, id: string): NodeState {
  switch (id) {
    case "tool":
      return t < 400 ? "idle" : t < 1000 ? "resolving" : "done"
    case "spec-a":
    case "spec-b":
      if (t < 1000) return "idle"
      if (t < 1400) return "resolving"
      const doneAt = id === "spec-b" ? 3000 : 3600
      return t < doneAt ? "running" : "done"
    case "synth":
      return t < 4300 ? "idle" : t < 4600 ? "resolving" : t < 6400 ? "running" : "done"
    case "root":
      return t < 7000 ? "idle" : t < 8000 ? "done" : "done"
    default:
      return "idle"
  }
}

const PARTICLES: readonly Particle[] = [
  { edge: ["spec-b", "synth"], from: 3000, to: 3700 },
  { edge: ["spec-a", "synth"], from: 3600, to: 4300 },
  { edge: ["synth", "root"], from: 6400, to: 7000 },
]

// Inverted triangle: leaves on top, root at the bottom.
const NODES: readonly HeroNode[] = [
  { id: "tool", x: 0.28, y: 0.13 },
  { id: "spec-a", x: 0.28, y: 0.32 },
  { id: "spec-b", x: 0.72, y: 0.32 },
  { id: "synth", x: 0.5, y: 0.62 },
  { id: "root", x: 0.5, y: 0.88 },
]

const EDGES: ReadonlyArray<readonly [string, string]> = [
  ["root", "synth"],
  ["synth", "spec-a"],
  ["synth", "spec-b"],
  ["spec-a", "tool"],
]

export function initHeroTree(): void {
  const queried = document.querySelector<HTMLCanvasElement>("#hero-canvas")
  const cycleLabel = document.querySelector<HTMLElement>("#hero-cycle")
  if (!queried) return
  // Aliased so nested closures keep the non-null type.
  const canvas = queried

  const context2d = canvas.getContext("2d")
  if (!context2d) return
  const context = context2d

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches
  let width = 0
  let height = 0
  let running = true
  let raf = 0
  let startedAt = performance.now()
  let cycle = 0

  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const rect = canvas.getBoundingClientRect()
    width = rect.width
    height = rect.height
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    context!.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function point(id: string): { x: number; y: number } {
    const node = NODES.find(candidate => candidate.id === id)!
    return { x: node.x * width, y: node.y * height }
  }

  function label(id: string): string {
    switch (id) {
      case "root":
        return "<WeeklyStandup />"
      case "synth":
        return "<Agent /> synthesize"
      case "spec-a":
        return `<Agent /> ${GATHERERS[0]}`
      case "spec-b":
        return `<Agent /> ${GATHERERS[1]}`
      default:
        return "<Mcp /> linear"
    }
  }

  function drawNode(id: string, state: NodeState, t: number): void {
    const { x, y } = point(id)
    const text = label(id)
    context!.font = "600 11px 'IBM Plex Mono', monospace"
    const w = context!.measureText(text).width + 22
    const h = 28

    if (state === "running") {
      const pulse = (t % 1100) / 1100
      context!.beginPath()
      context!.roundRect(x - w / 2 - pulse * 10, y - h / 2 - pulse * 10, w + pulse * 20, h + pulse * 20, 10)
      context!.strokeStyle = SIGNAL
      context!.globalAlpha = 0.55 * (1 - pulse)
      context!.lineWidth = 1.5
      context!.stroke()
      context!.globalAlpha = 1
    }

    const [fill, stroke] =
      state === "done"
        ? [OK_SOFT, OK]
        : state === "running"
          ? [SIGNAL_SOFT, SIGNAL]
          : state === "resolving"
            ? [RESOLVE_SOFT, RESOLVE]
            : ["#ffffff", LINE]

    context!.beginPath()
    context!.roundRect(x - w / 2, y - h / 2, w, h, 8)
    context!.fillStyle = fill
    context!.fill()
    context!.strokeStyle = stroke
    context!.lineWidth = 1.4
    context!.setLineDash(state === "idle" ? [4, 3] : [])
    context!.stroke()
    context!.setLineDash([])

    context!.fillStyle = state === "idle" ? MUTED : INK
    context!.textAlign = "center"
    context!.textBaseline = "middle"
    context!.fillText(text, x, y + 0.5)

    if (state === "done") {
      context!.fillStyle = OK
      context!.beginPath()
      context!.arc(x + w / 2 - 1, y - h / 2 + 1, 6, 0, Math.PI * 2)
      context!.fill()
      context!.strokeStyle = "#fff"
      context!.lineWidth = 1.6
      context!.beginPath()
      context!.moveTo(x + w / 2 - 3.4, y - h / 2 + 1)
      context!.lineTo(x + w / 2 - 1.2, y - h / 2 + 3.2)
      context!.lineTo(x + w / 2 + 3.6, y - h / 2 - 2.6)
      context!.stroke()
    }
  }

  function drawEdge(a: string, b: string, t: number): void {
    const pa = point(a)
    const pb = point(b)
    const done = stateAt(t, b) === "done"
    context!.beginPath()
    context!.moveTo(pa.x, pa.y)
    context!.lineTo(pb.x, pb.y)
    context!.strokeStyle = done ? OK : LINE
    context!.lineWidth = 1.4
    context!.stroke()
  }

  function drawParticles(t: number): void {
    for (const particle of PARTICLES) {
      if (t < particle.from || t > particle.to) continue
      const progress = (t - particle.from) / (particle.to - particle.from)
      const eased = 1 - (1 - progress) ** 3
      const from = point(particle.edge[0])
      const to = point(particle.edge[1])
      const x = from.x + (to.x - from.x) * eased
      const y = from.y + (to.y - from.y) * eased

      context!.beginPath()
      context!.arc(x, y, 4.5, 0, Math.PI * 2)
      context!.fillStyle = RESOLVE
      context!.globalAlpha = 0.25
      context!.fill()
      context!.globalAlpha = 1
      context!.beginPath()
      context!.arc(x, y, 2.6, 0, Math.PI * 2)
      context!.fillStyle = RESOLVE
      context!.fill()
    }
  }

  function frame(now: number): void {
    if (!running) return

    // rAF timestamps can predate the init-time performance.now() by a few
    // ms; without the clamp the first frame computes cycle -1 and crashes.
    const elapsed = Math.max(0, now - startedAt)
    const t = elapsed % CYCLE_MS
    const currentCycle = Math.floor(elapsed / CYCLE_MS)
    if (currentCycle !== cycle) {
      cycle = currentCycle
      if (cycleLabel) cycleLabel.textContent = `cycle ${cycle + 1}`
    }

    context!.clearRect(0, 0, width, height)
    for (const [a, b] of EDGES) drawEdge(a, b, t)
    for (const node of NODES) drawNode(node.id, stateAt(t, node.id), t)
    drawParticles(t)

    if (t > 7050 && t < 7900) {
      // Final output flash under the root node.
      const { x, y } = point("root")
      context!.font = "500 10.5px 'IBM Plex Mono', monospace"
      context!.fillStyle = OK
      context!.textAlign = "center"
      context!.fillText('→ "weekly update ready"', x, y + 34)
    }

    raf = requestAnimationFrame(frame)
  }

  function drawStatic(): void {
    // Reduced motion: paint the completed end state once.
    context!.clearRect(0, 0, width, height)
    for (const [a, b] of EDGES) drawEdge(a, b, Infinity)
    for (const node of NODES) drawNode(node.id, "done", 0)
    if (cycleLabel) cycleLabel.textContent = "resolved"
  }

  resize()
  new ResizeObserver(() => {
    resize()
    if (reduceMotion) drawStatic()
  }).observe(canvas)

  if (reduceMotion) {
    drawStatic()
    return
  }

  // Pause the loop while the hero is offscreen to save battery.
  new IntersectionObserver(
    ([entry]) => {
      if (entry?.isIntersecting && !running) {
        running = true
        startedAt = performance.now() - (cycle * CYCLE_MS + CYCLE_MS / 2)
        raf = requestAnimationFrame(frame)
      } else if (!entry?.isIntersecting && running) {
        running = false
        cancelAnimationFrame(raf)
      }
    },
    { threshold: 0.05 }
  ).observe(canvas)

  raf = requestAnimationFrame(frame)
}
