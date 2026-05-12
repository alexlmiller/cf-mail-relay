// Shot catalogue. Each entry produces one PNG in infra/screenshots/out/.
// Curated shots are copied into docs/images/ via `pnpm screenshots:publish`.

import type { Page } from "playwright";
import { adminFixtures, emptyFixtures, senderFixtures, type FixtureMap } from "./fixtures";

export interface Shot {
  /** Stable filename slug (no extension). */
  name: string;
  /** Which dataset to load before navigation. */
  fixtures: FixtureMap;
  /** Hash route to load — "/" lands on dashboard. */
  route: string;
  /** Viewport width × height. Default 1440×900. */
  viewport?: { width: number; height: number };
  /**
   * After navigation completes, run any pre-shot actions: open a modal,
   * click a row, press a keyboard shortcut, etc.
   */
  setup?: (page: Page) => Promise<void>;
  /** Optional CSS selector to wait for before capturing (in addition to networkidle). */
  waitFor?: string;
}

export function shots(): Shot[] {
  return [
    // 1 — Hero: populated dashboard
    {
      name: "01-dashboard",
      fixtures: adminFixtures(),
      route: "/",
      waitFor: ".health-grid .health-item",
    },

    // 2 — First-run dashboard with checklist
    {
      name: "02-dashboard-first-run",
      fixtures: emptyFixtures(),
      route: "/",
      waitFor: ".checklist ol",
    },

    // 3 — Command palette overlaid on dashboard
    {
      name: "03-command-palette",
      fixtures: adminFixtures(),
      route: "/",
      waitFor: ".health-grid .health-item",
      setup: async (page) => {
        await page.waitForSelector(".health-grid .health-item");
        await page.keyboard.press("Meta+K");
        // Wait until the palette input is actually focused before typing —
        // typing into an unfocused element drops the first keystroke.
        const input = page.locator("[role='dialog'] input, .palette input").first();
        await input.waitFor({ state: "visible", timeout: 3000 });
        await input.focus();
        await page.waitForTimeout(120);
        await input.fill("new");
      },
    },

    // 4 — Events list with detail drawer open
    {
      name: "04-events-drawer",
      fixtures: adminFixtures(),
      route: "/events",
      setup: async (page) => {
        // Wait for first row, then click to open the drawer on the policy_rejected event.
        await page.waitForSelector("table tbody tr, .table tbody tr, [data-event-id]");
        // Click the third row (policy_rejected) to surface a failure reason in the drawer.
        const target = page.locator("tbody tr").nth(3);
        if (await target.count()) {
          await target.click();
        } else {
          await page.locator("tbody tr").first().click();
        }
        await page.waitForSelector(".drawer, [data-drawer-open], [role='complementary']", { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(150);
      },
    },

    // 5 — Domain detail with DNS-record helpers
    {
      name: "05-domain-detail",
      fixtures: adminFixtures(),
      route: "/domains/dom_01HQA6V3JZP5NXKR7T4MWQDB28",
      waitFor: ".page-head h1",
    },

    // 6 — Senders list
    {
      name: "06-senders",
      fixtures: adminFixtures(),
      route: "/senders",
      waitFor: "table tbody tr, .table tbody tr",
    },

    // 7 — Create SMTP credential → secret reveal modal
    {
      name: "07-credential-reveal",
      fixtures: adminFixtures(),
      route: "/credentials?new=1",
      setup: async (page) => {
        // Wait for the create modal to mount.
        await page.waitForSelector("input[name='name']", { timeout: 5000 });
        await page.fill("input[name='name']", "Production Rails app");
        await page.fill("input[name='username']", "smtp-prod-app");
        // Submit via the form's primary button.
        await page.locator("button.btn.primary", { hasText: /create credential/i }).first().click();
        // Wait for the secret-reveal modal to replace the create modal.
        await page.waitForSelector("text=/will not be shown again|reveal|copy/i", { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(200);
      },
    },

    // 8 — API Keys list
    {
      name: "08-api-keys",
      fixtures: adminFixtures(),
      route: "/api-keys",
      waitFor: "table tbody tr, .table tbody tr",
    },

    // 9 — Sender self-service /me view
    {
      name: "09-self-me",
      fixtures: senderFixtures(),
      route: "/me",
      waitFor: ".card",
    },

    // 10 — Users list (admin)
    {
      name: "10-users",
      fixtures: adminFixtures(),
      route: "/users",
      waitFor: "table tbody tr, .table tbody tr",
    },

    // 11 — Auth failures view
    {
      name: "11-auth-failures",
      fixtures: adminFixtures(),
      route: "/events",
      setup: async (page) => {
        // The "events" view also hosts auth failures via a tab/section.
        // If there's a dedicated tab, click it; otherwise scroll the failures table into view.
        const tab = page.locator("button, a", { hasText: /auth ?failures/i }).first();
        if (await tab.count()) {
          await tab.click().catch(() => {});
        }
        await page.waitForTimeout(150);
      },
    },

    // 12 — Domains list
    {
      name: "12-domains",
      fixtures: adminFixtures(),
      route: "/domains",
      waitFor: "table tbody tr, .table tbody tr",
    },

    // ──────────── Mobile variants (iPhone 14/15) ────────────
    // Same fixtures + routes as 01/04/07/09 at iPhone viewport so we can spot
    // responsive regressions. Not promoted to docs/images/ — staging only.

    // 13 — Mobile dashboard
    {
      name: "13-mobile-dashboard",
      fixtures: adminFixtures(),
      route: "/",
      viewport: { width: 390, height: 844 },
      waitFor: ".health-grid .health-item",
    },

    // 14 — Mobile events: card-layout list + drawer
    {
      name: "14-mobile-events",
      fixtures: adminFixtures(),
      route: "/events",
      viewport: { width: 390, height: 844 },
      waitFor: "tbody tr",
    },

    // 15 — Mobile credential reveal: full-screen modal
    {
      name: "15-mobile-credential-reveal",
      fixtures: adminFixtures(),
      route: "/credentials?new=1",
      viewport: { width: 390, height: 844 },
      setup: async (page) => {
        await page.waitForSelector("input[name='name']", { timeout: 5000 });
        await page.fill("input[name='name']", "Production Rails app");
        await page.fill("input[name='username']", "smtp-prod-app");
        await page.locator("button.btn.primary", { hasText: /create credential/i }).first().click();
        await page.waitForSelector("text=/will not be shown again|reveal|copy/i", { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(200);
      },
    },

    // 16 — Mobile /me self-service
    {
      name: "16-mobile-self-me",
      fixtures: senderFixtures(),
      route: "/me",
      viewport: { width: 390, height: 844 },
      waitFor: ".card",
    },

    // 18 — Mobile senders (card layout)
    {
      name: "18-mobile-senders",
      fixtures: adminFixtures(),
      route: "/senders",
      viewport: { width: 390, height: 844 },
      waitFor: "tbody tr",
    },

    // 19 — Mobile domains (currently narrower than other tables)
    {
      name: "19-mobile-domains",
      fixtures: adminFixtures(),
      route: "/domains",
      viewport: { width: 390, height: 844 },
      waitFor: "tbody tr",
    },

    // 19 — Mobile SMTP credentials (stacked actions + card layout)
    {
      name: "19-mobile-credentials",
      fixtures: adminFixtures(),
      route: "/credentials",
      viewport: { width: 390, height: 844 },
      waitFor: "tbody tr",
    },

    // 20 — Mobile API keys (same header/action rhythm as credentials)
    {
      name: "20-mobile-api-keys",
      fixtures: adminFixtures(),
      route: "/api-keys",
      viewport: { width: 390, height: 844 },
      waitFor: "tbody tr",
    },

    // 17 — Mobile nav open (hamburger expanded)
    {
      name: "17-mobile-nav-open",
      fixtures: adminFixtures(),
      route: "/",
      viewport: { width: 390, height: 844 },
      waitFor: ".health-grid .health-item",
      setup: async (page) => {
        const toggle = page.locator(".nav-toggle").first();
        await toggle.waitFor({ state: "visible", timeout: 3000 });
        await toggle.click();
        await page.waitForTimeout(150);
      },
    },
  ];
}
