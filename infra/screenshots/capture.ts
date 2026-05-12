/* eslint-disable no-console */
// Screenshot generator. Boots a tiny static server over worker/public/, drives
// Playwright Chromium through the shot catalogue with fetch-intercept fixtures,
// writes PNGs to infra/screenshots/out/.
//
// Run: pnpm screenshots          (all shots)
//      pnpm screenshots dashboard (single shot, prefix match)

import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { shots, type Shot } from "./shots.config";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const PUBLIC_DIR = join(REPO_ROOT, "worker", "public");
const OUT_DIR = join(REPO_ROOT, "infra", "screenshots", "out");
const INTERCEPT_PATH = join(REPO_ROOT, "infra", "screenshots", "intercept.js");

const PORT = 5181;
const VIEWPORT = { width: 1440, height: 900 } as const;
const DEVICE_SCALE_FACTOR = 2;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function ensureBuild(): Promise<void> {
  if (existsSync(join(PUBLIC_DIR, "index.html"))) return;
  console.log("[screenshots] worker/public/index.html missing — running ui build…");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("pnpm", ["--filter", "@cf-mail-relay/ui", "build"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    child.on("close", (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error(`ui build exited ${code}`))));
    child.on("error", rejectPromise);
  });
}

function startStaticServer(): Promise<{ close: () => Promise<void>; origin: string }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      let filePath = join(PUBLIC_DIR, pathname);
      if (!filePath.startsWith(PUBLIC_DIR)) {
        res.statusCode = 403;
        res.end();
        return;
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        // SPA fallback — Workers Static Assets does the same when not_found_handling = "single-page-application".
        filePath = join(PUBLIC_DIR, "index.html");
        if (!existsSync(filePath)) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
      }
      res.statusCode = 200;
      res.setHeader("content-type", MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream");
      res.setHeader("cache-control", "no-store");
      createReadStream(filePath).pipe(res);
    });
    server.listen(PORT, () => {
      resolvePromise({
        origin: `http://127.0.0.1:${PORT}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

async function captureShot(browser: Browser, origin: string, shot: Shot): Promise<void> {
  const viewport = shot.viewport ?? VIEWPORT;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "America/Denver",
  });

  // Inject fixtures + interceptor before any page script runs.
  const interceptSrc = readFileSync(INTERCEPT_PATH, "utf-8");
  await context.addInitScript({
    content:
      `window.__SCREENSHOT_FIXTURES__ = ${JSON.stringify(shot.fixtures)};\n` +
      `try { localStorage.setItem("cfmr-theme", "light"); } catch {}\n` +
      interceptSrc,
  });

  const page = await context.newPage();
  page.on("pageerror", (err) => console.error(`[${shot.name}] pageerror:`, err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error(`[${shot.name}] console.error:`, msg.text());
  });

  const url = `${origin}/#${shot.route.startsWith("/") ? shot.route : `/${shot.route}`}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Wait for the UI's session-driven shell to mount.
  await page.waitForSelector(".topbar", { timeout: 10_000 });

  if (shot.waitFor) {
    await page.waitForSelector(shot.waitFor, { timeout: 5_000 }).catch(() => {
      console.warn(`[${shot.name}] waitFor selector "${shot.waitFor}" not found, continuing anyway`);
    });
  }

  // Let layout/animations settle.
  await page.waitForTimeout(250);

  if (shot.setup) await shot.setup(page);
  await page.waitForTimeout(150);

  const outPath = join(OUT_DIR, `${shot.name}.png`);
  await page.screenshot({ path: outPath, fullPage: false });
  await context.close();
  console.log(`[screenshots] ${shot.name} → ${outPath.replace(REPO_ROOT + "/", "")}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  await ensureBuild();

  const filterArg = process.argv[2];
  const all = shots();
  const selected = filterArg ? all.filter((s) => s.name.includes(filterArg)) : all;
  if (selected.length === 0) {
    console.error(`No shots match "${filterArg}". Available:\n  ${all.map((s) => s.name).join("\n  ")}`);
    process.exit(2);
  }

  const server = await startStaticServer();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const shot of selected) {
      try {
        await captureShot(browser, server.origin, shot);
      } catch (error) {
        console.error(`[screenshots] ${shot.name} FAILED:`, error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
