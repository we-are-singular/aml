/** Adds the pointer glow and gentle motion to the hero's floating annotations. */
export function initAmbient(): void {
  // Soft glow that trails the pointer across the hero.
  const glow = document.querySelector<HTMLElement>("#hero-glow")
  const hero = glow?.parentElement
  if (glow && hero && matchMedia("(pointer: fine)").matches) {
    hero.addEventListener("pointermove", (event) => {
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
        { duration: 4200 + index * 700, iterations: Infinity, easing: "ease-in-out" },
      )
    })
  }

  // A small perspective shift makes dense cards feel tactile without affecting touch or keyboard use.
  if (!reduceMotion && matchMedia("(min-width: 640px) and (hover: hover) and (pointer: fine)").matches) {
    document.querySelectorAll<HTMLElement>(".magnetic-card").forEach((card) => {
      card.addEventListener("pointermove", (event) => {
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
