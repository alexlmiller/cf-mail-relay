// Slide-in detail drawer.

import type { Child } from "./dom";
import { h, icon, on, setChildren } from "./dom";

interface OpenOptions {
  title: string;
  crumbs?: Child[];
  body: Child;
  footer?: Child;
  onClose?: () => void;
}

let backdrop: HTMLElement | null = null;
let panel: HTMLElement | null = null;
let body: HTMLElement | null = null;
let foot: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let crumbsEl: HTMLElement | null = null;
let closeHandler: (() => void) | null = null;
let escDisposer: (() => void) | null = null;

function ensureMounted() {
  if (backdrop && panel) return;
  backdrop = h("div", { class: "drawer-backdrop", "data-role": "drawer-backdrop" });
  panel = h("aside", { class: "drawer", role: "dialog", "aria-modal": "true", "aria-labelledby": "drawer-title" });

  crumbsEl = h("div", { class: "crumbs" });
  titleEl = h("h2", { id: "drawer-title" });
  const closeBtn = h(
    "button",
    {
      type: "button",
      class: "iconbtn",
      "aria-label": "Close",
      title: "Close (Esc)",
      "on:click": () => close(),
    },
    icon("x", 16),
  );
  const head = h(
    "header",
    { class: "drawer-head" },
    h("div", { class: "stack", style: "gap: 2px" }, crumbsEl, titleEl),
    closeBtn,
  );

  body = h("div", { class: "drawer-body" });
  foot = h("footer", { class: "drawer-foot hidden" });

  panel.appendChild(head);
  panel.appendChild(body);
  panel.appendChild(foot);

  document.body.appendChild(backdrop);
  document.body.appendChild(panel);

  on(backdrop, "click", () => close());
}

export function openDrawer(options: OpenOptions) {
  ensureMounted();
  if (!backdrop || !panel || !body || !foot || !titleEl || !crumbsEl) return;
  setChildren(crumbsEl, ...(options.crumbs ?? []));
  titleEl.textContent = options.title;
  setChildren(body, options.body);
  if (options.footer) {
    foot.classList.remove("hidden");
    setChildren(foot, options.footer);
  } else {
    foot.classList.add("hidden");
    setChildren(foot);
  }
  closeHandler = options.onClose ?? null;

  requestAnimationFrame(() => {
    backdrop?.classList.add("open");
    panel?.classList.add("open");
  });

  escDisposer?.();
  escDisposer = on(window, "keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
}

export function close() {
  if (!backdrop || !panel) return;
  backdrop.classList.remove("open");
  panel.classList.remove("open");
  closeHandler?.();
  closeHandler = null;
  escDisposer?.();
  escDisposer = null;
}

export function crumb(text: string, isLast = false): HTMLElement {
  return h("span", { class: isLast ? "" : "" }, text);
}

export function crumbSep(): HTMLElement {
  return h("span", { class: "sep" }, "/");
}
