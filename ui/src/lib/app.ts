// Boot module. Fetches session, then mounts the appropriate shell (admin vs
// sender) and wires the router. Every authenticated user can reach #/me
// for their own profile; admins additionally get the full nav.

import { ApiError, setApiBase } from "./api";
import { api } from "./api";
import { selfApi, selfLoginUrl, setSelfApiBase } from "./api-self";
import { h, icon, on, setChildren } from "./dom";
import { initialsFor } from "./format";
import { openPalette, setPaletteItems, type PaletteItem } from "./palette";
import { close as closeDrawer } from "./drawer";
import { closeModal } from "./modal";
import { applyTheme, cycle as cycleTheme, initTheme, loadMode, onChange as onThemeChange } from "./theme";
import { navigate, parse, start as startRouter, subscribe } from "./router";
import { runUserWizard } from "./wizard";

import { renderDashboard } from "./views/dashboard";
import { renderEvents } from "./views/events";
import { renderDomains, openNewDomain } from "./views/domains";
import { renderDomainDetail } from "./views/domain-detail";
import { renderSenders, openNewSender } from "./views/senders";
import { renderCredentials, openNewCredential } from "./views/credentials";
import { openNewApiKey } from "./views/api-keys";
import { renderUsers, openCreateUserSimple } from "./views/users";
import { renderUserDetail } from "./views/user-detail";
import { renderSettings } from "./views/settings";
import { renderMe, openCreateCredential as openSelfCredential, openCreateApiKey as openSelfApiKey } from "./views/me";
import type { Session } from "./types";

interface NavItem {
  label: string;
  route: string;
  match: (name: string) => boolean;
}

const ADMIN_NAV: NavItem[] = [
  { label: "Dashboard", route: "/", match: (n) => n === "dashboard" },
  { label: "Events", route: "/events", match: (n) => n === "events" },
  { label: "Senders", route: "/senders", match: (n) => n === "senders" },
  { label: "Credentials", route: "/credentials", match: (n) => n === "credentials" || n === "api-keys" },
  { label: "Users", route: "/users", match: (n) => n === "users" || n === "user-detail" },
  { label: "Settings", route: "/settings", match: (n) => n === "settings" || n === "domains" || n === "domain-detail" },
];

let session: Session | null = null;
let appRoot: HTMLElement | null = null;
let routeRoot: HTMLElement | null = null;
let topbarUserSlot: HTMLElement | null = null;

/**
 * The brand glyph used in the topbar brand-mark. Same envelope-as-arrow
 * geometry as ui/public/favicon.svg, but without the dark background
 * (the .brand-mark element provides that).
 */
function brandGlyph(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 22 12");
  svg.setAttribute("aria-hidden", "true");
  const body = document.createElementNS(ns, "path");
  body.setAttribute("d", "M0 0 L17 0 L22 6 L17 12 L0 12 Z");
  const flap = document.createElementNS(ns, "path");
  flap.setAttribute("d", "M0 0 L8.5 6 L17 0");
  svg.appendChild(body);
  svg.appendChild(flap);
  return svg;
}

export function boot() {
  appRoot = document.getElementById("app");
  if (!appRoot) return;
  const apiBase = appRoot.dataset.apiBase ?? "";
  setApiBase(apiBase);
  setSelfApiBase(apiBase);
  initTheme();
  applyTheme(loadMode());

  paintLoading();
  void boostrapSession();
}

function paintLoading() {
  if (!appRoot) return;
  setChildren(
    appRoot,
    h(
      "div",
      { style: "min-height: 100vh; display: grid; place-items: center;" },
      h("div", { class: "soft", style: "font-family: 'JetBrains Mono', monospace; font-size: 12px;" }, "loading…"),
    ),
  );
}

async function boostrapSession() {
  try {
    session = await selfApi.session();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      paintAccessGate(error.message);
      return;
    }
    paintAccessGate("network_error");
    return;
  }

  registerKeyboardShortcuts();

  if (session.user.role === "admin") {
    buildAdminShell();
    registerAdminPaletteItems();
  } else {
    buildSenderShell();
    registerSenderPaletteItems();
  }

  subscribe(handleRouteChange);
  startRouter();
}

// ───────────────────────── Admin shell ─────────────────────────

function buildAdminShell() {
  if (!appRoot || !session) return;

  const brand = h(
    "a",
    { class: "brand", href: "#/", title: "CF Mail Relay" },
    h("span", { class: "brand-mark" }, brandGlyph()),
    h("span", { class: "brand-name" }, "CF Mail Relay"),
  );

  const navEl = h("nav", { class: "nav", "aria-label": "Primary" });
  for (const item of ADMIN_NAV) {
    const link = h("a", { href: `#${item.route}`, "data-route": item.route }, item.label);
    on(link, "click", () => closeNav());
    navEl.appendChild(link);
  }

  const navToggle = h(
    "button",
    {
      type: "button",
      class: "nav-toggle",
      "aria-label": "Toggle navigation",
      "aria-expanded": "false",
      "aria-controls": "primary-nav",
      "on:click": () => toggleNav(),
    },
    h("span", { class: "bars" }),
  );
  navEl.id = "primary-nav";

  const right = buildTopbarRight();
  const topbarInner = h("div", { class: "topbar-inner" }, navToggle, brand, navEl, right);
  const topbar = h("header", { class: "topbar", role: "banner" }, topbarInner);

  const main = h("main", { class: "main", id: "main", role: "main" });
  routeRoot = h("div", { id: "route" });
  main.appendChild(routeRoot);

  setChildren(appRoot, h("div", { class: "shell" }, topbar, main));
  syncUserChip();
}

// ───────────────────────── Sender shell ─────────────────────────

function buildSenderShell() {
  if (!appRoot || !session) return;

  const brand = h(
    "a",
    { class: "brand", href: "#/me", title: "CF Mail Relay" },
    h("span", { class: "brand-mark" }, brandGlyph()),
    h("span", { class: "brand-name" }, "CF Mail Relay"),
  );

  // Sender has no nav links — there's only one page.
  const right = buildTopbarRight();
  const topbarInner = h("div", { class: "topbar-inner" }, brand, h("div", { class: "flex-fill" }), right);
  const topbar = h("header", { class: "topbar", role: "banner" }, topbarInner);

  const main = h("main", { class: "main", id: "main", role: "main" });
  routeRoot = h("div", { id: "route" });
  main.appendChild(routeRoot);

  setChildren(appRoot, h("div", { class: "shell" }, topbar, main));
  syncUserChip();
}

// ───────────────────────── Topbar right (theme + user) ─────────────────────────

function buildTopbarRight(): HTMLElement {
  const searchCue = h(
    "button",
    {
      type: "button",
      class: "searchcue",
      title: "Open command palette (⌘K)",
      "on:click": () => openPalette(),
    },
    h("span", { class: "glyph" }, icon("search", 13)),
    h("span", { class: "label flex-fill", style: "text-align: left" }, "Search…"),
    h("span", { class: "kbd-cluster" }, h("span", { class: "kbd" }, "⌘"), h("span", { class: "kbd" }, "K")),
  );

  topbarUserSlot = h("span", { class: "soft", style: "font-size: 12px" }, "—");
  const userChip = h(
    "a",
    {
      class: "user-chip",
      title: "Your account",
      href: "#/me",
    },
    h("span", { class: "avatar" }, "·"),
    topbarUserSlot,
  );

  const themeBtn = h(
    "button",
    {
      type: "button",
      class: "iconbtn",
      title: `Theme: ${loadMode()}`,
      "aria-label": "Toggle theme",
      "on:click": () => {
        const next = cycleTheme();
        themeBtn.title = `Theme: ${next}`;
      },
    },
    icon(getThemeIcon(), 14),
  );

  onThemeChange((resolved, mode) => {
    setChildren(themeBtn, icon(resolved === "dark" ? "sun" : "moon", 14));
    themeBtn.title = `Theme: ${mode}`;
  });

  return h("div", { class: "topbar-right" }, searchCue, themeBtn, userChip);
}

function syncUserChip() {
  if (!topbarUserSlot || !session) return;
  const userChip = topbarUserSlot.closest(".user-chip");
  const avatar = userChip?.querySelector(".avatar");
  if (avatar) avatar.textContent = initialsFor(session.user.email);
  const span = h("span", { class: "email" }, session.user.email);
  topbarUserSlot.replaceWith(span);
  topbarUserSlot = span;
}

function getThemeIcon(): "sun" | "moon" {
  const resolved = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  return resolved === "dark" ? "sun" : "moon";
}

// ───────────────────────── Keyboard shortcuts ─────────────────────────

function registerKeyboardShortcuts() {
  on(window, "keydown", (event) => {
    const meta = event.metaKey || event.ctrlKey;
    if (event.key === "Escape" && appRoot?.querySelector<HTMLElement>(".topbar")?.dataset.navOpen === "1") {
      closeNav();
      return;
    }
    if (meta && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openPalette();
    } else if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      openPalette();
    } else if (event.key === "g" && !event.metaKey && !event.ctrlKey) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      armGotoSequence();
    }
  });
}

function armGotoSequence() {
  const dispose = on(window, "keydown", (event) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
      dispose();
      return;
    }
    const isAdmin = session?.user.role === "admin";
    const adminMap: Record<string, string> = {
      d: "/",
      e: "/events",
      o: "/settings",
      s: "/senders",
      c: "/credentials",
      k: "/credentials",
      u: "/users",
      m: "/me",
    };
    const senderMap: Record<string, string> = { m: "/me" };
    const route = (isAdmin ? adminMap : senderMap)[event.key.toLowerCase()];
    if (route) {
      event.preventDefault();
      navigate(route);
    }
    dispose();
  }, { once: false });
  window.setTimeout(dispose, 1200);
}

// ───────────────────────── Palettes ─────────────────────────

function registerAdminPaletteItems() {
  setPaletteItems((): PaletteItem[] => [
    ...ADMIN_NAV.map((item) => ({
      id: `goto-${item.route}`,
      group: "Navigate",
      label: item.label,
      meta: `g · ${item.route}`,
      glyph: "→",
      run: () => navigate(item.route),
    })),
    {
      id: "goto-me",
      group: "Navigate",
      label: "Your account",
      meta: "g m · /me",
      glyph: "→",
      run: () => navigate("/me"),
    },
    {
      id: "new-user-wizard",
      group: "Create",
      label: "Set up sender (guided)",
      meta: "user → sender → credential",
      glyph: "✦",
      run: async () => {
        const [users, senders, credentials, apiKeys] = await Promise.all([
          api.listUsers(), api.listSenders(), api.listSmtpCredentials(), api.listApiKeys(),
        ]);
        runUserWizard({
          snapshot: { users, senders, credentials, apiKeys },
          onDone: () => reRender(),
        });
      },
    },
    { id: "new-user", group: "Create", label: "New user", glyph: "+", run: () => openCreateUserSimple(() => reRender()) },
    { id: "new-domain", group: "Create", label: "New domain", glyph: "+", run: () => openNewDomain(() => reRender()) },
    {
      id: "new-sender",
      group: "Create",
      label: "Grant sender",
      glyph: "+",
      run: async () => {
        const [domains, users] = await Promise.all([api.listDomains(), api.listUsers()]);
        openNewSender(domains, users, () => reRender());
      },
    },
    {
      id: "new-credential",
      group: "Create",
      label: "New SMTP credential",
      glyph: "+",
      run: async () => {
        const [users, senders] = await Promise.all([api.listUsers(), api.listSenders()]);
        openNewCredential(users, senders, () => reRender());
      },
    },
    {
      id: "new-api-key",
      group: "Create",
      label: "New API key",
      glyph: "+",
      run: async () => {
        const [users, senders] = await Promise.all([api.listUsers(), api.listSenders()]);
        openNewApiKey(users, senders, () => reRender());
      },
    },
    ...themePaletteItems(),
  ]);
}

function registerSenderPaletteItems() {
  setPaletteItems((): PaletteItem[] => [
    { id: "goto-me", group: "Navigate", label: "Your account", meta: "/me", glyph: "→", run: () => navigate("/me") },
    {
      id: "new-credential-self",
      group: "Create",
      label: "New SMTP credential",
      glyph: "+",
      run: () => {
        if (routeRoot) openSelfCredential(routeRoot);
      },
    },
    {
      id: "new-api-key-self",
      group: "Create",
      label: "New API key",
      glyph: "+",
      run: () => {
        if (routeRoot) openSelfApiKey(routeRoot);
      },
    },
    ...themePaletteItems(),
  ]);
}

function themePaletteItems(): PaletteItem[] {
  return [
    { id: "theme-auto", group: "Theme", label: "Match system", glyph: "◐", run: () => applyTheme("auto") },
    { id: "theme-light", group: "Theme", label: "Light", glyph: "☼", run: () => applyTheme("light") },
    { id: "theme-dark", group: "Theme", label: "Dark", glyph: "☾", run: () => applyTheme("dark") },
  ];
}

// ───────────────────────── Routing ─────────────────────────

function handleRouteChange(route: ReturnType<typeof parse>) {
  if (!routeRoot || !session) return;
  closeDrawer();
  closeModal();
  closeNav();

  if (session.user.role !== "admin") {
    // Senders: every route collapses to /me. Don't leave broken state on a
    // stale bookmark; silently redirect to /me if the URL doesn't match.
    if (route.name !== "me") {
      navigate("/me");
      return;
    }
    syncNavActive(route.name);
    void renderMe(routeRoot);
    return;
  }

  syncNavActive(route.name);

  switch (route.name) {
    case "dashboard":
      void renderDashboard(routeRoot);
      break;
    case "events":
      void renderEvents(routeRoot);
      break;
    case "domains":
      void renderDomains(routeRoot);
      break;
    case "domain-detail":
      if (route.params.id) void renderDomainDetail(routeRoot, route.params.id);
      else navigate("/domains");
      break;
    case "senders":
      void renderSenders(routeRoot);
      break;
    case "credentials":
      void renderCredentials(routeRoot);
      break;
    case "api-keys":
      // Legacy route — both surfaces now live on /credentials.
      navigate("/credentials");
      break;
    case "users":
      void renderUsers(routeRoot);
      break;
    case "user-detail":
      if (route.params.id) void renderUserDetail(routeRoot, route.params.id);
      else navigate("/users");
      break;
    case "me":
      void renderMe(routeRoot);
      break;
    case "settings":
      void renderSettings(routeRoot);
      break;
    default:
      paintNotFound();
  }
}

function paintNotFound() {
  if (!routeRoot) return;
  setChildren(
    routeRoot,
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "empty" },
        h("div", { class: "empty-title" }, "Page not found"),
        h("div", { class: "empty-sub" }, "That route doesn't exist. Try ⌘K to jump somewhere."),
        h("div", { class: "empty-actions" }, h("a", { class: "btn primary", href: "#/" }, "Dashboard")),
      ),
    ),
  );
}

function toggleNav() {
  const topbar = appRoot?.querySelector<HTMLElement>(".topbar");
  if (!topbar) return;
  const open = topbar.dataset.navOpen === "1";
  if (open) closeNav();
  else openNav();
}

function openNav() {
  const topbar = appRoot?.querySelector<HTMLElement>(".topbar");
  const toggle = topbar?.querySelector<HTMLButtonElement>(".nav-toggle");
  if (!topbar) return;
  topbar.dataset.navOpen = "1";
  if (toggle) toggle.setAttribute("aria-expanded", "true");
}

function closeNav() {
  const topbar = appRoot?.querySelector<HTMLElement>(".topbar");
  const toggle = topbar?.querySelector<HTMLButtonElement>(".nav-toggle");
  if (!topbar) return;
  delete topbar.dataset.navOpen;
  if (toggle) toggle.setAttribute("aria-expanded", "false");
}

function syncNavActive(name: string) {
  if (!appRoot) return;
  const links = appRoot.querySelectorAll<HTMLAnchorElement>(".nav a[data-route]");
  for (const link of links) {
    const route = link.dataset.route ?? "";
    const item = ADMIN_NAV.find((n) => n.route === route);
    if (item?.match(name)) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function reRender() {
  const current = parse();
  handleRouteChange(current);
}

// ───────────────────────── Access gate ─────────────────────────

function paintAccessGate(reason: string) {
  if (!appRoot) return;
  setChildren(
    appRoot,
    h(
      "div",
      { style: "min-height: 100vh; display: grid; place-items: center; padding: 24px" },
      h(
        "div",
        { class: "card", style: "max-width: 520px; width: 100%" },
        h("div", { class: "card-head" }, h("h2", null, "Access required")),
        h(
          "div",
          { class: "card-body stack", style: "gap: 12px" },
          h(
            "div",
            { class: "soft", style: "font-size: 13.5px; line-height: 1.55" },
            "This dashboard is gated by Cloudflare Access. You're either not signed in, or your identity isn't provisioned on this relay.",
          ),
          h("div", { class: "banner bad" }, icon("warn", 14), `Reason: ${reason}`),
          h(
            "div",
            { class: "row" },
            h(
              "button",
              { type: "button", class: "btn primary", "on:click": () => window.location.assign(selfLoginUrl()) },
              icon("refresh", 13),
              "Sign in again",
            ),
          ),
        ),
      ),
    ),
  );
}
