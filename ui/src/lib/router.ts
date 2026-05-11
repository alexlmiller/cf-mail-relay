// Hash-based router. Routes are #/path?query.
// We avoid a generic regex matcher — the route set is small and explicit.

export interface Route {
  name: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
}

type Listener = (route: Route) => void;

const listeners = new Set<Listener>();

export function parse(): Route {
  const hash = location.hash.slice(1) || "/";
  const [pathRaw, queryRaw = ""] = hash.split("?", 2);
  const path = pathRaw.startsWith("/") ? pathRaw : `/${pathRaw}`;
  const query = new URLSearchParams(queryRaw);
  const params: Record<string, string> = {};

  // ── Route matching ──
  // /                          → dashboard
  // /events                    → events
  // /domains                   → domains
  // /domains/<id>              → domain-detail
  // /senders                   → senders
  // /credentials               → credentials
  // /api-keys                  → api-keys
  // /users                     → users
  // /users/<id>                → user-detail
  const segments = path.split("/").filter(Boolean);
  let name = "dashboard";

  if (segments.length === 0) {
    name = "dashboard";
  } else if (segments[0] === "events") {
    name = "events";
  } else if (segments[0] === "domains") {
    if (segments.length > 1) {
      name = "domain-detail";
      params.id = segments[1]!;
    } else {
      name = "domains";
    }
  } else if (segments[0] === "senders") {
    name = "senders";
  } else if (segments[0] === "credentials") {
    name = "credentials";
  } else if (segments[0] === "api-keys") {
    name = "api-keys";
  } else if (segments[0] === "users") {
    if (segments.length > 1) {
      name = "user-detail";
      params.id = segments[1]!;
    } else {
      name = "users";
    }
  } else if (segments[0] === "me") {
    name = "me";
  } else {
    name = "not-found";
  }

  return { name, path, query, params };
}

export function navigate(path: string, query?: Record<string, string | undefined>) {
  const search = query
    ? Object.entries(query)
        .filter(([, value]) => value !== undefined && value !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  const hash = `#${path}${search ? `?${search}` : ""}`;
  if (location.hash === hash) return;
  location.hash = hash;
}

export function replaceQuery(query: Record<string, string | undefined>) {
  const route = parse();
  const next = new URLSearchParams(route.query);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") next.delete(k);
    else next.set(k, v);
  }
  const str = next.toString();
  const hash = `#${route.path}${str ? `?${str}` : ""}`;
  if (location.hash === hash) return;
  // Update without re-firing the listener if only the query changed silently.
  history.replaceState(null, "", hash);
  fire();
}

function fire() {
  const route = parse();
  for (const listener of listeners) listener(route);
}

export function start() {
  window.addEventListener("hashchange", fire);
  // Defer first fire by a microtask so listeners are subscribed.
  queueMicrotask(fire);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
