import { highlightLines } from "./highlight"
import { SCENARIOS, type PlayEvent, type Scenario } from "./scenarios"

const SVG_NS = "http://www.w3.org/2000/svg"
/** output typewriter speed at 1x, in characters per ms of virtual time */
const CHARS_PER_MS = 0.055

/**
 * Drives one scripted scenario run on a virtual clock: events fire when the
 * (speed-scaled) elapsed time passes their `at` timestamp, so the speed
 * slider retimes code highlights, node states, traces, and typing uniformly.
 */
class PlaygroundRunner {
  private scenario: Scenario = SCENARIOS[0]!
  private raf = 0
  private running = false
  private speed = 1
  private virtual = 0
  private lastFrame = 0
  private eventIndex = 0
  private outputQueue = ""
  private typedChars = 0
  private typeStart = 0

  private readonly tabs = document.querySelector<HTMLElement>("#pg-tabs")!
  private readonly title = document.querySelector<HTMLElement>("#pg-title")!
  private readonly file = document.querySelector<HTMLElement>("#pg-file")!
  private readonly code = document.querySelector<HTMLElement>("#pg-code")!
  private readonly tree = document.querySelector<SVGSVGElement>("#pg-tree")!
  private readonly trace = document.querySelector<HTMLOListElement>("#pg-trace")!
  private readonly output = document.querySelector<HTMLElement>("#pg-output")!
  private readonly runButton = document.querySelector<HTMLButtonElement>("#pg-run")!
  private readonly speedInput = document.querySelector<HTMLInputElement>("#pg-speed")!

  async init(): Promise<void> {
    for (const scenario of SCENARIOS) {
      const tab = document.createElement("button")
      tab.setAttribute("role", "tab")
      tab.dataset.scenario = scenario.id
      tab.textContent = scenario.tab
      tab.className =
        "rounded-full border border-line bg-surface px-4 py-2 font-mono text-[12.5px] font-medium transition-all hover:border-line-strong"
      tab.addEventListener("click", () => {
        if (this.scenario.id !== scenario.id) {
          void this.load(scenario)
        }
      })
      this.tabs.append(tab)
    }

    this.runButton.addEventListener("click", () => this.run())
    this.speedInput.addEventListener("input", () => {
      this.speed = Number(this.speedInput.value)
    })

    await this.load(this.scenario)

    // Auto-run the first scenario once, the first time it scrolls into view.
    new IntersectionObserver(
      ([entry], observer) => {
        if (entry?.isIntersecting) {
          observer.disconnect()
          this.run()
        }
      },
      { threshold: 0.35 },
    ).observe(this.tree)
  }

  private async load(scenario: Scenario): Promise<void> {
    this.stop()
    this.scenario = scenario
    this.title.textContent = scenario.title
    this.file.textContent = scenario.file
    this.code.innerHTML = await highlightLines(scenario.code)
    this.trace.innerHTML = ""
    this.output.textContent = ""
    this.output.classList.remove("caret")
    this.renderTree()
    this.resetVisualState()
    this.tabs.querySelectorAll<HTMLButtonElement>("[data-scenario]").forEach((tab) => {
      const isActive = tab.dataset.scenario === scenario.id
      // Active and inactive backgrounds conflict as classes; Tailwind's
      // stylesheet order (not class-list order) decides, so swap explicitly.
      tab.classList.toggle("bg-ink", isActive)
      tab.classList.toggle("text-paper", isActive)
      tab.classList.toggle("border-ink", isActive)
      tab.classList.toggle("bg-surface", !isActive)
      tab.classList.toggle("border-line", !isActive)
      tab.setAttribute("aria-selected", String(isActive))
    })
  }

  private renderTree(): void {
    this.tree.innerHTML = ""
    const nodeById = new Map(this.scenario.nodes.map((node) => [node.id, node]))

    for (const edge of this.scenario.edges) {
      const from = nodeById.get(edge.from)!
      const to = nodeById.get(edge.to)!
      const line = document.createElementNS(SVG_NS, "line")
      line.setAttribute("x1", String(from.x))
      line.setAttribute("y1", String(from.y))
      line.setAttribute("x2", String(to.x))
      line.setAttribute("y2", String(to.y))
      line.setAttribute("class", "pg-edge")
      line.dataset.edge = edge.id
      this.tree.append(line)
    }

    for (const node of this.scenario.nodes) {
      const width = node.label.length * 6.7 + 20
      const group = document.createElementNS(SVG_NS, "g")
      group.setAttribute("class", "pg-node")
      group.dataset.state = "idle"
      group.dataset.node = node.id

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

      group.append(halo, box, text)
      this.tree.append(group)
    }
  }

  private resetVisualState(): void {
    this.tree.querySelectorAll<SVGGElement>("[data-node]").forEach((node) => {
      node.dataset.state = "idle"
    })
    this.tree.querySelectorAll<SVGLineElement>("[data-edge]").forEach((edge) => {
      edge.classList.remove("is-hot", "is-done")
    })
    this.code.querySelectorAll(".code-line.is-active").forEach((line) => {
      line.classList.remove("is-active")
    })
  }

  run(): void {
    if (this.running) return
    this.running = true
    this.runButton.disabled = true
    this.runButton.textContent = "… running"
    this.resetVisualState()
    this.trace.innerHTML = ""
    this.output.textContent = ""
    this.output.classList.add("caret")

    this.virtual = 0
    this.eventIndex = 0
    this.outputQueue = ""
    this.typedChars = 0
    this.lastFrame = performance.now()

    const tick = (now: number): void => {
      this.virtual += (now - this.lastFrame) * this.speed
      this.lastFrame = now

      while (this.eventIndex < this.scenario.events.length) {
        const event = this.scenario.events[this.eventIndex]!
        if (event.at > this.virtual) break
        this.apply(event)
        this.eventIndex += 1
      }

      this.drainOutput()

      if (this.virtual >= this.scenario.duration && this.outputQueue === "") {
        this.finish()
        return
      }
      this.raf = requestAnimationFrame(tick)
    }

    this.raf = requestAnimationFrame(tick)
  }

  private apply(event: PlayEvent): void {
    switch (event.kind) {
      case "code": {
        this.code.querySelectorAll(".code-line.is-active").forEach((line) => {
          line.classList.remove("is-active")
        })
        for (const line of event.lines) {
          this.code.querySelector(`[data-line="${line}"]`)?.classList.add("is-active")
        }
        break
      }
      case "node": {
        const node = this.tree.querySelector<SVGGElement>(`[data-node="${event.id}"]`)
        if (node) node.dataset.state = event.state
        break
      }
      case "edge": {
        const edge = this.tree.querySelector<SVGLineElement>(`[data-edge="${event.id}"]`)
        if (!edge) break
        edge.classList.toggle("is-hot", event.state === "hot")
        edge.classList.toggle("is-done", event.state === "done")
        break
      }
      case "trace": {
        const item = document.createElement("li")
        const time = document.createElement("span")
        time.className = "text-line-strong"
        time.textContent = `+${(event.at / 1000).toFixed(1)}s `
        const text = document.createElement("span")
        text.className =
          event.tone === "ok" ? "text-ok" : event.tone === "warn" ? "text-signal" : "text-muted"
        text.textContent = event.text
        item.append(time, text)
        this.trace.append(item)
        this.trace.scrollTop = this.trace.scrollHeight
        break
      }
      case "output": {
        // Restart the typewriter clock when a fresh chunk arrives so text
        // types from the moment it is produced, not from run start.
        if (this.outputQueue === "") {
          this.typeStart = this.virtual
          this.typedChars = 0
        }
        this.outputQueue += event.text
        break
      }
    }
  }

  private drainOutput(): void {
    if (this.outputQueue === "") return
    const target = Math.floor((this.virtual - this.typeStart) * CHARS_PER_MS)
    const take = Math.min(this.outputQueue.length, Math.max(0, target - this.typedChars))
    if (take === 0) return
    this.output.textContent += this.outputQueue.slice(0, take)
    this.outputQueue = this.outputQueue.slice(take)
    this.typedChars += take
  }

  private finish(): void {
    this.output.textContent += this.outputQueue
    this.outputQueue = ""
    this.output.classList.remove("caret")
    this.running = false
    this.runButton.disabled = false
    this.runButton.textContent = "↻ re-run"
  }

  private stop(): void {
    cancelAnimationFrame(this.raf)
    this.running = false
    this.runButton.disabled = false
    this.runButton.textContent = "▶ run"
  }
}

export function initPlayground(): void {
  if (!document.querySelector("#pg-tree")) return
  new PlaygroundRunner().init()
}
