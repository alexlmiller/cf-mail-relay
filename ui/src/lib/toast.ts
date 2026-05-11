// Simple toast stack pinned to the bottom of the viewport.

import { h, icon, setChildren } from "./dom";

let stack: HTMLElement | null = null;
function ensureStack(): HTMLElement {
  if (stack && document.body.contains(stack)) return stack;
  stack = h("div", { class: "toast-stack", role: "status", "aria-live": "polite" });
  document.body.appendChild(stack);
  return stack;
}

export function toast(message: string, kind: "ok" | "err" = "ok", durationMs = 1800) {
  const target = ensureStack();
  const node = h("div", { class: `toast${kind === "err" ? " err" : ""}` });
  setChildren(node, icon(kind === "err" ? "warn" : "check", 14), message);
  target.appendChild(node);
  window.setTimeout(() => {
    node.style.transition = "opacity .18s, transform .18s";
    node.style.opacity = "0";
    node.style.transform = "translateY(6px)";
    window.setTimeout(() => node.remove(), 200);
  }, durationMs);
}

export async function copy(value: string, label = "Copied") {
  try {
    await navigator.clipboard.writeText(value);
    toast(label, "ok");
  } catch {
    // Fallback for environments without Clipboard API.
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      toast(label, "ok");
    } catch {
      toast("Copy failed", "err");
    } finally {
      textarea.remove();
    }
  }
}
