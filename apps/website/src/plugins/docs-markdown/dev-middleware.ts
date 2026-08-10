import { defineMiddleware } from "astro:middleware"

export const onRequest = defineMiddleware(async (context, next) => {
  if (!context.url.pathname.endsWith(".md")) return next()

  // Astro 5 applies the global `trailingSlash: "always"` policy to dynamic injected routes in dev.
  // Rewrite internally so the public `/page.md` shortcut matches the endpoint without changing the browser URL.
  const endpointUrl = new URL(context.url)
  endpointUrl.pathname = `${endpointUrl.pathname}/`
  try {
    return await context.rewrite(endpointUrl)
  } catch (error) {
    if (error instanceof Error && error.name === "NoMatchingStaticPathFound") {
      return new Response("Documentation page not found.\n", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    }
    throw error
  }
})
