// Boot module. Mounts the shell, wires the router, initializes the palette,
// and dispatches to the appropriate view module on every hash change.

import { api, ApiError, setApiBase } from "./api";
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
import { renderApiKeys, openNewApiKey } from "./views/api-keys";
import { renderUsers, openCreateUserSimple } from "./views/users";
import { renderUserDetail } from "./views/user-detail";
import type { Session } from "./types";

interface NavItem {
  label: string;
  route: string;
  match: (name: string) => boolean;
}

const NAV: NavItem[] = [
  { label: "Dashboard", route: "/", match: (n) => n === "dashboard" },
  { label: "Events", route: "/events", match: (n) => n === "events" },
  { label: "Domains", route: "/domains", match: (n) => n === "domains" || n === "domain-detail" },
  { label: "Senders", route: "/senders", match: (n) => n === "senders" },
  { label: "Credentials", route: "/credentials", match: (n) => n === "credentials" },
  { label: "Keys", route: "/api-keys", match: (n) => n === "api-keys" },
  { label: "Users", route: "/users", match: (n) => n === "users" || n === "user-detail" },
];

let session: Session | null = null;
let appRoot: HTMLElement | null = null;
let mainRoot: HTMLElement | null = null;
let routeRoot: HTMLElement | null = null;
let topbarUserSlot: HTMLElement | null = null;
let topbarRouteSlot: HTMLElement | null = null;

export function boot() {
  appRoot = document.getElementById("app");
  if (!appRoot) return;
  const apiBase = appRoot.dataset.apiBase ?? "";
  setApiBase(apiBase);
  initTheme();
  applyTheme(loadMode());

  buildShell();
  registerKeyboardShortcuts();
  registerPaletteItems();
  loadSession();

  subscribe(handleRouteChange);
  startRouter();
}

function buildShell() {
  if (!appRoot) return;

  const brandMark = h("span", { class: "brand-mark" }, "CR");
  topbarRouteSlot = h("span", { class: "brand-route" }, "/");
  const brand = h(
    "a",
    { class: "brand", href: "#/", title: "CF Mail Relay" },
    brandMark,
    h("span", { class: "brand-name" }, "Mail Relay"),
    h("span", { class: "brand-sep" }, "/"),
    topbarRouteSlot,
  );

  const navEl = h("nav", { class: "nav", "aria-label": "Primary" });
  for (const item of NAV) {
    navEl.appendChild(h("a", { href: `#${item.route}`, "data-route": item.route }, item.label));
  }

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
    "button",
    {
      type: "button",
      class: "user-chip",
      title: "Account",
      "on:click": () => openPalette(),
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

  const right = h("div", { class: "topbar-right" }, searchCue, themeBtn, userChip);
  const topbarInner = h("div", { class: "topbar-inner" }, brand, navEl, right);
  const topbar = h("header", { class: "topbar", role: "banner" }, topbarInner);

  mainRoot = h("main", { class: "main", id: "main", role: "main" });
  routeRoot = h("div", { id: "route" });
  mainRoot.appendChild(routeRoot);

  const shell = h("div", { class: "shell" }, topbar, mainRoot);
  setChildren(appRoot, shell);
}

function getThemeIcon(): "sun" | "moon" {
  const resolved = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  return resolved === "dark" ? "sun" : "moon";
}

function registerKeyboardShortcuts() {
  on(window, "keydown", (event) => {
    const meta = event.metaKey || event.ctrlKey;
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
    const map: Record<string, string> = {
      d: "/",
      e: "/events",
      o: "/domains",
      s: "/senders",
      c: "/credentials",
      k: "/api-keys",
      u: "/users",
    };
    const route = map[event.key.toLowerCase()];
    if (route) {
      event.preventDefault();
      navigate(route);
    }
    dispose();
  }, { once: false });
  window.setTimeout(dispose, 1200);
}

function registerPaletteItems() {
  setPaletteItems((): PaletteItem[] => {
    const items: PaletteItem[] = [
      ...NAV.map((item) => ({
        id: `goto-${item.route}`,
        group: "Navigate",
        label: item.label,
        meta: `g · ${item.route}`,
        glyph: "→",
        run: () => navigate(item.route),
      })),
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
      {
        id: "new-user",
        group: "Create",
        label: "New user",
        meta: "user only",
        glyph: "+",
        run: () => openCreateUserSimple(() => reRender()),
      },
      {
        id: "new-domain",
        group: "Create",
        label: "New domain",
        glyph: "+",
        run: () => openNewDomain(() => reRender()),
      },
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
      {
        id: "theme-auto",
        group: "Theme",
        label: "Match system",
        glyph: "◐",
        run: () => applyTheme("auto"),
      },
      {
        id: "theme-light",
        group: "Theme",
        label: "Light",
        glyph: "☼",
        run: () => applyTheme("light"),
      },
      {
        id: "theme-dark",
        group: "Theme",
        label: "Dark",
        glyph: "☾",
        run: () => applyTheme("dark"),
      },
    ];
    return items;
  });
}

async function loadSession() {
  try {
    session = await api.session();
    if (topbarUserSlot && session) {
      const userChip = topbarUserSlot.closest(".user-chip");
      const avatar = userChip?.querySelector(".avatar");
      if (avatar) avatar.textContent = initialsFor(session.user.email);
      const span = h("span", { class: "email" }, session.user.email);
      topbarUserSlot.replaceWith(span);
      topbarUserSlot = span;
    }
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      paintAccessGate(error.message);
    }
  }
}

function paintAccessGate(reason: string) {
  if (!routeRoot) return;
  setChildren(
    routeRoot,
    h(
      "div",
      { class: "card", style: "max-width: 560px; margin: 80px auto" },
      h("div", { class: "card-head" }, h("h2", null, "Cloudflare Access required")),
      h(
        "div",
        { class: "card-body stack", style: "gap: 12px" },
        h(
          "div",
          { class: "soft", style: "font-size: 13.5px; line-height: 1.55" },
          "This admin UI is gated by Cloudflare Access. You're either not signed in, or your identity isn't allowed to administer the relay.",
        ),
        h("div", { class: "banner bad" }, icon("warn", 14), `Reason: ${reason}`),
        h(
          "div",
          { class: "row" },
          h(
            "button",
            {
              type: "button",
              class: "btn primary",
              "on:click": () => {
                window.location.reload();
              },
            },
            icon("refresh", 13),
            "Sign in again",
          ),
        ),
      ),
    ),
  );
}

function handleRouteChange(route: ReturnType<typeof parse>) {
  if (!routeRoot) return;
  closeDrawer();
  closeModal();
  syncNavActive(route.name);
  if (topbarRouteSlot) topbarRouteSlot.textContent = route.path;

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
      void renderApiKeys(routeRoot);
      break;
    case "users":
      void renderUsers(routeRoot);
      break;
    case "user-detail":
      if (route.params.id) void renderUserDetail(routeRoot, route.params.id);
      else navigate("/users");
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

function syncNavActive(name: string) {
  if (!appRoot) return;
  const links = appRoot.querySelectorAll<HTMLAnchorElement>(".nav a[data-route]");
  for (const link of links) {
    const route = link.dataset.route ?? "";
    const item = NAV.find((n) => n.route === route);
    if (item?.match(name)) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function reRender() {
  const current = parse();
  handleRouteChange(current);
}
