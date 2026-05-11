// ⌘K command palette.

import type { Child } from "./dom";
import { h, icon, on, setChildren } from "./dom";

export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  meta?: string;
  hint?: string;
  glyph?: string;
  run: () => void | Promise<void>;
}

let backdrop: HTMLElement | null = null;
let modal: HTMLElement | null = null;
let searchInput: HTMLInputElement | null = null;
let list: HTMLElement | null = null;
let getItems: (() => PaletteItem[]) | null = null;
let escDisposer: (() => void) | null = null;
let activeIndex = 0;
let filtered: PaletteItem[] = [];

function ensureMounted() {
  if (backdrop) return;
  backdrop = h("div", { class: "modal-backdrop", "data-role": "palette-backdrop" });
  modal = h("div", { class: "modal palette", role: "dialog", "aria-modal": "true", "aria-labelledby": "palette-search" });
  searchInput = h("input", {
    type: "text",
    id: "palette-search",
    placeholder: "Search commands, jump to a page…",
    autocomplete: "off",
    spellcheck: false,
  }) as HTMLInputElement;
  const head = h(
    "header",
    { class: "palette-search" },
    h("span", { class: "glyph" }, icon("search", 16)),
    searchInput,
    h("span", { class: "kbd-cluster" }, h("span", { class: "kbd" }, "Esc")),
  );
  list = h("div", { class: "palette-list" });
  const foot = h(
    "footer",
    { class: "palette-foot" },
    h(
      "div",
      { class: "hints" },
      h("span", { class: "hint" }, h("span", { class: "kbd" }, "↑"), h("span", { class: "kbd" }, "↓"), "navigate"),
      h("span", { class: "hint" }, h("span", { class: "kbd" }, "↵"), "select"),
    ),
    h("span", { class: "soft" }, "CF Mail Relay"),
  );
  modal.appendChild(head);
  modal.appendChild(list);
  modal.appendChild(foot);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  on(backdrop, "click", (event) => {
    if (event.target === backdrop) closePalette();
  });
  on(searchInput, "input", () => render());
  on(searchInput, "keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      activeIndex = Math.min(activeIndex + 1, Math.max(filtered.length - 1, 0));
      render(true);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      render(true);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = filtered[activeIndex];
      if (item) {
        closePalette();
        void item.run();
      }
    }
  });
}

export function setPaletteItems(provider: () => PaletteItem[]) {
  getItems = provider;
}

export function openPalette() {
  ensureMounted();
  if (!backdrop || !searchInput) return;
  activeIndex = 0;
  searchInput.value = "";
  render();
  requestAnimationFrame(() => backdrop?.classList.add("open"));
  window.setTimeout(() => searchInput?.focus(), 30);
  escDisposer?.();
  escDisposer = on(window, "keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
    }
  });
}

export function closePalette() {
  if (!backdrop) return;
  backdrop.classList.remove("open");
  escDisposer?.();
  escDisposer = null;
}

function fuzzy(label: string, query: string): boolean {
  if (query.length === 0) return true;
  const hay = label.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  for (const char of q) {
    const found = hay.indexOf(char, i);
    if (found === -1) return false;
    i = found + 1;
  }
  return true;
}

function render(scroll = false) {
  if (!list || !searchInput) return;
  const items = getItems?.() ?? [];
  const q = searchInput.value.trim();
  filtered = items.filter((item) => fuzzy(`${item.label} ${item.group} ${item.meta ?? ""}`, q));
  if (activeIndex >= filtered.length) activeIndex = Math.max(filtered.length - 1, 0);

  setChildren(list);

  if (filtered.length === 0) {
    list.appendChild(h("div", { class: "palette-empty" }, "No commands match."));
    return;
  }

  let currentGroup = "";
  filtered.forEach((item, index) => {
    if (item.group !== currentGroup) {
      currentGroup = item.group;
      list!.appendChild(h("div", { class: "palette-section" }, currentGroup));
    }
    const button: HTMLElement = h(
      "button",
      {
        type: "button",
        class: "palette-item",
        "data-id": item.id,
        "data-active": index === activeIndex ? "true" : "false",
        "on:mouseenter": () => {
          activeIndex = index;
          for (const node of list!.querySelectorAll<HTMLElement>(".palette-item")) {
            node.dataset.active = "false";
          }
          button.dataset.active = "true";
        },
        "on:click": () => {
          closePalette();
          void item.run();
        },
      },
      h("span", { class: "glyph" }, item.glyph ?? ""),
      h("span", { class: "label" }, item.label) as Child,
      item.meta ? h("span", { class: "meta" }, item.meta) : false,
    );
    list!.appendChild(button);
  });

  if (scroll) {
    const active = list.querySelector<HTMLElement>(".palette-item[data-active='true']");
    active?.scrollIntoView({ block: "nearest" });
  }
}
