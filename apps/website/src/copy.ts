/** Generic copy buttons: [data-copy] for literal text, [data-copy-target] for element content. */
export function initCopy(): void {
  document.querySelectorAll<HTMLButtonElement>(".copy-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const literal = button.dataset.copy
      const targetId = button.dataset.copyTarget
      const text =
        literal ?? (targetId ? document.getElementById(targetId)?.innerText : undefined)
      if (text === undefined) return

      await navigator.clipboard.writeText(text.trim())
      const previous = button.textContent
      button.textContent = "copied ✓"
      window.setTimeout(() => (button.textContent = previous), 1200)
    })
  })
}
