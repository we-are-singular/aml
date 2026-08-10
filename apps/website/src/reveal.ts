/** Reveals marked marketing elements once as they enter the viewport. */
export function initReveal(): void {
  const elements = document.querySelectorAll<HTMLElement>(".reveal")
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches

  if (elements.length === 0 || prefersReducedMotion || !("IntersectionObserver" in window)) {
    return
  }

  // Content stays visible unless the observer is available and initialized.
  document.documentElement.classList.add("reveal-ready")

  const observer = new IntersectionObserver(
    entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue

        entry.target.classList.add("is-visible")
        observer.unobserve(entry.target)
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
  )

  elements.forEach(element => observer.observe(element))
}
