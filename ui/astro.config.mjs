import { defineConfig } from "astro/config";

// The admin UI is bundled into the Worker (Workers Static Assets) so the
// dashboard and the API share an origin. Build output goes to ../worker/public/
// which the Worker serves directly. No separate Pages project.
export default defineConfig({
  output: "static",
  outDir: "../worker/public",
  // During `pnpm --filter ui dev`, forward API calls to a local wrangler dev
  // worker on :8787 so the same-origin contract holds in development too.
  vite: {
    server: {
      proxy: {
        "/admin/api": "http://localhost:8787",
        "/self/api": "http://localhost:8787",
        "/relay": "http://localhost:8787",
        "/send": "http://localhost:8787",
        "/healthz": "http://localhost:8787",
        "/bootstrap": "http://localhost:8787",
      },
    },
  },
});
