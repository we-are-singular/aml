/** Adds the pointer glow and gentle motion to the hero's floating annotations. */
export function initAmbient(): void {
  // Soft glow that trails the pointer across the hero.
  const glow = document.querySelector<HTMLElement>("#hero-glow")
  const hero = glow?.parentElement
  if (glow && hero && matchMedia("(pointer: fine)").matches) {
    hero.addEventListener("pointermove", event => {
      const rect = hero.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      glow.style.background = `radial-gradient(360px circle at ${x}px ${y}px, color-mix(in srgb, var(--color-resolve) 7%, transparent), transparent 70%)`
    })
    hero.addEventListener("pointerleave", () => {
      glow.style.background = "none"
    })
  }

  // Gentle float for the hero chips.
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches
  if (!reduceMotion && matchMedia("(min-width: 640px)").matches) {
    document.querySelectorAll<HTMLElement>("[data-float]").forEach((chip, index) => {
      chip.animate(
        [
          { transform: "translateY(0px)" },
          { transform: `translateY(${index % 2 === 0 ? -9 : 9}px)` },
          { transform: "translateY(0px)" },
        ],
        { duration: 4200 + index * 700, iterations: Infinity, easing: "ease-in-out" }
      )
    })
  }

  // A small perspective shift makes dense cards feel tactile without affecting touch or keyboard use.
  if (!reduceMotion && matchMedia("(min-width: 640px) and (hover: hover) and (pointer: fine)").matches) {
    document.querySelectorAll<HTMLElement>(".magnetic-card").forEach(card => {
      card.addEventListener("pointermove", event => {
        const rect = card.getBoundingClientRect()
        const x = (event.clientX - rect.left) / rect.width - 0.5
        const y = (event.clientY - rect.top) / rect.height - 0.5

        card.style.setProperty("--card-rotate-x", `${y * -2}deg`)
        card.style.setProperty("--card-rotate-y", `${x * 2}deg`)
        card.style.setProperty("--card-glow-x", `${(x + 0.5) * 100}%`)
        card.style.setProperty("--card-glow-y", `${(y + 0.5) * 100}%`)
      })

      card.addEventListener("pointerleave", () => {
        card.style.removeProperty("--card-rotate-x")
        card.style.removeProperty("--card-rotate-y")
        card.style.removeProperty("--card-glow-x")
        card.style.removeProperty("--card-glow-y")
      })
    })
  }
}

/** Reveals pointer constellations and pauses the card's CSS star rotation when it is not visible. */
export function initContributionConstellation(): void {
  const section = document.querySelector<HTMLElement>("#contributing")
  const field = section?.querySelector<SVGSVGElement>(".contributing-stars")
  const path = field?.querySelector<SVGPathElement>(".contributing-connections")
  if (!section || !field || !path) return

  let visible = false
  const updateRotation = (): void => {
    section.classList.toggle("has-visible-stars", visible && !document.hidden)
  }
  const observer = new IntersectionObserver(entries => {
    visible = entries[0]?.isIntersecting ?? false
    updateRotation()
  })
  observer.observe(section.querySelector(".contributing-card") ?? section)
  document.addEventListener("visibilitychange", updateRotation)

  const enabled = matchMedia("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)")
  const stars = [...field.querySelectorAll("circle")].map(element => ({
    element,
    x: element.cx.baseVal.value,
    y: element.cy.baseVal.value,
  }))
  let frame = 0
  let pointerX = 0
  let pointerY = 0
  let active: typeof stars = []

  function clear(): void {
    cancelAnimationFrame(frame)
    frame = 0
    field!.classList.remove("is-active")
    for (const star of active) star.element.classList.remove("is-near")
    active = []
  }

  section.addEventListener(
    "pointermove",
    event => {
      if (!enabled.matches || event.pointerType === "touch") return
      // The card covers the field; only its surrounding background responds to the pointer.
      if (event.target instanceof Element && event.target.closest(".contributing-card")) {
        clear()
        return
      }
      pointerX = event.clientX
      pointerY = event.clientY
      // Coalesce pointer events into one update per painted frame; never schedule another from here.
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const rect = field.getBoundingClientRect()
        const x = pointerX - rect.left
        const y = pointerY - rect.top
        const nearby = stars
          .map(star => ({
            ...star,
            distance: Math.hypot((star.x * rect.width) / 1000 - x, (star.y * rect.height) / 400 - y),
          }))
          .filter(star => star.distance < 180)
          .sort((a, b) => a.distance - b.distance)
          .slice(0, 6)

        // Connect each star to the closest earlier one, forming a small constellation rather than a mesh.
        const segments = nearby.slice(1).map((star, index) => {
          const previous = nearby.slice(0, index + 1)
          const closest = previous.reduce((best, candidate) => {
            const distance = (point: typeof star) =>
              Math.hypot(((point.x - star.x) * rect.width) / 1000, ((point.y - star.y) * rect.height) / 400)
            return distance(candidate) < distance(best) ? candidate : best
          })
          return `M${star.x} ${star.y}L${closest.x} ${closest.y}`
        })
        path.setAttribute("d", segments.join(" "))
        for (const star of active) star.element.classList.remove("is-near")
        for (const star of nearby) star.element.classList.add("is-near")
        active = nearby
        field.classList.toggle("is-active", nearby.length > 1)
      })
    },
    { passive: true }
  )

  section.addEventListener("pointerleave", clear)
  section.addEventListener("pointercancel", clear)
  enabled.addEventListener("change", clear)
  document.addEventListener("visibilitychange", clear)
  window.addEventListener("blur", clear)
}
