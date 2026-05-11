// Theme manager. Three modes: "auto" follows the OS, "light" and "dark" pin.

export type ThemeMode = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "cfmr-theme";
const listeners = new Set<(resolved: ResolvedTheme, mode: ThemeMode) => void>();

let media: MediaQueryList | null = null;
function getMedia(): MediaQueryList | null {
  if (typeof window === "undefined") return null;
  if (media === null) media = window.matchMedia("(prefers-color-scheme: dark)");
  return media;
}

export function loadMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "auto") return stored;
  } catch {
    // ignore
  }
  return "auto";
}

export function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === "light" || mode === "dark") return mode;
  return getMedia()?.matches ? "dark" : "light";
}

export function applyTheme(mode: ThemeMode) {
  const resolved = resolve(mode);
  document.documentElement.dataset.theme = resolved;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore
  }
  for (const listener of listeners) listener(resolved, mode);
}

export function setMode(mode: ThemeMode) {
  applyTheme(mode);
}

export function cycle(): ThemeMode {
  const order: ThemeMode[] = ["auto", "light", "dark"];
  const current = loadMode();
  const next = order[(order.indexOf(current) + 1) % order.length] ?? "auto";
  applyTheme(next);
  return next;
}

export function onChange(listener: (resolved: ResolvedTheme, mode: ThemeMode) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initTheme() {
  const media = getMedia();
  if (!media) return;
  // Re-apply on OS preference change when mode is "auto".
  const handler = () => {
    if (loadMode() === "auto") applyTheme("auto");
  };
  if (typeof media.addEventListener === "function") media.addEventListener("change", handler);
  else if (typeof media.addListener === "function") media.addListener(handler);
}
