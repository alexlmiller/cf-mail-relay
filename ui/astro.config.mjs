import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  output: "static",
  adapter: cloudflare(),
  // MS3: configure Pages-to-Worker fetches and CORS allow-list.
});
