// Tiny DOM helpers. The whole app is built on these — keep the surface narrow.

type EventName = keyof HTMLElementEventMap;
type Attrs = {
  class?: string;
  id?: string;
  for?: string;
  href?: string;
  type?: string;
  role?: string;
  title?: string;
  placeholder?: string;
  name?: string;
  value?: string | number;
  disabled?: boolean;
  checked?: boolean;
  autocomplete?: string;
  autofocus?: boolean;
  spellcheck?: boolean;
  required?: boolean;
  rows?: number;
  cols?: number;
  tabindex?: number;
  style?: string;
  hidden?: boolean;
  [key: `data-${string}`]: string | number | boolean | undefined;
  [key: `aria-${string}`]: string | number | boolean | undefined;
  [key: `on:${string}`]: ((event: Event) => void) | undefined;
};

export type Child = Node | string | number | false | null | undefined;

/** Create an element. Strings are escaped (set via textContent). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") {
        element.className = String(value);
      } else if (key.startsWith("on:") && typeof value === "function") {
        element.addEventListener(key.slice(3) as EventName, value as (e: Event) => void);
      } else if (key === "autofocus" && value) {
        element.setAttribute("autofocus", "");
      } else if (typeof value === "boolean") {
        if (value) element.setAttribute(key, "");
      } else {
        element.setAttribute(key, String(value));
      }
    }
  }
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    if (child instanceof Node) element.appendChild(child);
    else element.appendChild(document.createTextNode(String(child)));
  }
  return element;
}

/** Quick fragment for grouping children. */
export function fragment(...children: Child[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    if (child instanceof Node) frag.appendChild(child);
    else frag.appendChild(document.createTextNode(String(child)));
  }
  return frag;
}

/** Replace element children. */
export function setChildren(target: HTMLElement, ...children: Child[]) {
  target.replaceChildren();
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    if (child instanceof Node) target.appendChild(child);
    else target.appendChild(document.createTextNode(String(child)));
  }
}

export function on<K extends EventName>(
  target: EventTarget,
  event: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(event, handler as EventListener, options);
  return () => target.removeEventListener(event, handler as EventListener, options);
}

/** Escape arbitrary text for placement in an attribute or innerHTML context. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    char === "&" ? "&amp;" :
    char === "<" ? "&lt;" :
    char === ">" ? "&gt;" :
    char === '"' ? "&quot;" :
    "&#39;",
  );
}

export function svgIcon(path: string, size = 14): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", path);
  svg.appendChild(p);
  return svg;
}

export const icons = {
  search: "M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm10 2-4.35-4.35",
  copy: "M9 9h10v10H9zM5 5h10v10",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
  chevronRight: "m9 6 6 6-6 6",
  chevronDown: "m6 9 6 6 6-6",
  plus: "M12 5v14M5 12h14",
  sun: "M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z",
  moon: "M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z",
  refresh: "M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16m0 5v-5h5",
  external: "M15 3h6v6m0-6L10 14m-1-7H4v13h13v-5",
  arrowRight: "M5 12h14m-6-7 7 7-7 7",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z",
  globe: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10ZM2 12h20M12 2a15 15 0 0 1 0 20m0-20a15 15 0 0 0 0 20",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  key: "M15 7a4 4 0 1 1-4 4M11 11l-7 7v3h3l1.5-1.5M7.5 17.5l3-3",
  warn: "M12 9v4m0 4h.01M5.07 19h13.86a2 2 0 0 0 1.73-3L13.73 4a2 2 0 0 0-3.46 0L3.34 16a2 2 0 0 0 1.73 3Z",
  info: "M12 16v-4m0-4h.01M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10Z",
  trash: "M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  filter: "M22 3H2l8 9.46V19l4 2v-8.54L22 3z",
  command: "M18 6a3 3 0 1 1-3 3V9h-6v0a3 3 0 1 1-3-3V6h0a3 3 0 0 1 3-3v0M9 15v0a3 3 0 1 1-3 3v0h0a3 3 0 0 1 3-3v0Zm9 0v0a3 3 0 1 1-3 3v0h0a3 3 0 0 1 3-3Zm-9 0h6",
  enter: "M9 10l-5 5 5 5m-5-5h12a5 5 0 0 0 5-5V4",
  arrowUpDown: "m7 15 5 5 5-5M7 9l5-5 5 5",
};

export type IconName = keyof typeof icons;

export function icon(name: IconName, size = 14): SVGSVGElement {
  return svgIcon(icons[name], size);
}
