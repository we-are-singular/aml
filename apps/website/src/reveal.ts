/** Adds .is-visible to .reveal elements as they enter the viewport. */
export function initReveal(): void {
  const elements = document.querySelectorAll<HTMLElement>(".reveal")

  if (!("IntersectionObserver" in window)) {
    elements.forEach(element => element.classList.add("is-visible"))
    return
  }

  const observer = new IntersectionObserver(
    entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible")
          observer.unobserve(entry.target)
        }
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
  )

  elements.forEach(element => observer.observe(element))
}
