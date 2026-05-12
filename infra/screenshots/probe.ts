/* eslint-disable no-console */
// One-off probe: opens the domains page in Playwright and dumps the computed
// box widths of the layout chain so we can pin down where the shrinkage is.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, createReadStream } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { adminFixtures } from "./fixtures";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const PUBLIC_DIR = join(REPO_ROOT, "worker", "public");
const INTERCEPT_PATH = join(REPO_ROOT, "infra", "screenshots", "intercept.js");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function startServer(): Promise<{ close: () => Promise<void>; origin: string }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      let pathname = decodeURIComponent(new URL(req.url ?? "/", `http://localhost:5181`).pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      let filePath = join(PUBLIC_DIR, pathname);
      if (!existsSync(filePath) || !statSync(filePath).isFile()) filePath = join(PUBLIC_DIR, "index.html");
      res.statusCode = 200;
      res.setHeader("content-type", MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream");
      createReadStream(filePath).pipe(res);
    });
    server.listen(5181, () => resolvePromise({ origin: "http://127.0.0.1:5181", close: () => new Promise((r) => server.close(() => r())) }));
  });
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const intercept = readFileSync(INTERCEPT_PATH, "utf-8");
  await context.addInitScript({
    content: `window.__SCREENSHOT_FIXTURES__ = ${JSON.stringify(adminFixtures())};\n${intercept}`,
  });
  const page = await context.newPage();
  await page.goto(`${server.origin}/#/domains`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".table-shell tbody tr", { timeout: 5000 });
  const widths = await page.evaluate(() => {
    const selectors = ["html", "body", "#app", ".shell", "main.main", "#route", "#domains-table", ".table-shell", ".table-wrap", "table.list"];
    return selectors.map((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return { sel, width: null };
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        sel,
        width: rect.width,
        display: cs.display,
        gridTemplateColumns: cs.gridTemplateColumns,
        maxWidth: cs.maxWidth,
        padding: cs.padding,
      };
    });
  });
  console.log(JSON.stringify(widths, null, 2));
  await browser.close();
  await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
