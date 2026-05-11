import { api } from "../api";
import type { Child } from "../dom";
import { h, icon, on, setChildren } from "../dom";
import { eventStatusPill, eventStatusKind } from "../status";
import { formatBytes, formatNumber, formatRelative, formatShort } from "../format";
import { navigate } from "../router";
import type { DashboardData, Domain, SendEvent, Sender, SmtpCredential, User } from "../types";

interface SnapshotState {
  dashboard?: DashboardData;
  domains?: Domain[];
  senders?: Sender[];
  credentials?: SmtpCredential[];
  users?: User[];
  events?: SendEvent[];
}

export async function renderDashboard(root: HTMLElement) {
  setChildren(root, head(), bodyShell());

  // Trigger refresh button wiring.
  const refresh = root.querySelector<HTMLButtonElement>("[data-refresh]");
  if (refresh) on(refresh, "click", () => renderDashboard(root));

  await load(root);
}

function head(): HTMLElement {
  return h(
    "header",
    { class: "page-head" },
    h(
      "div",
      null,
      h(
        "div",
        { class: "crumbs" },
        h("span", null, "—"),
        h("span", { class: "sep" }, "/"),
      ),
      h("h1", null, "Overview"),
    ),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        { type: "button", class: "btn ghost", "data-refresh": "1", title: "Reload" },
        icon("refresh", 13),
        "Refresh",
      ),
    ),
  );
}

function bodyShell(): HTMLElement {
  return h(
    "div",
    { class: "spread", id: "dashboard-body" },
    skeletonStats(),
    h("div", { id: "dashboard-checklist" }),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Cloudflare API"), h("span", { class: "soft", style: "font-size: 12px" }, "Checking…")), h("div", { class: "card-body" }, h("div", { class: "skeleton" }))),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Recent activity")), h("div", { class: "card-body" }, h("div", { class: "skeleton" }))),
  );
}

function skeletonStats(): HTMLElement {
  return h(
    "div",
    { class: "stats" },
    ...Array.from({ length: 4 }, () =>
      h(
        "div",
        { class: "stat" },
        h("div", { class: "stat-label" }, h("span", { class: "skeleton", style: "width: 60px" })),
        h("div", { class: "stat-value" }, h("span", { class: "skeleton", style: "width: 80px; height: 28px" })),
        h("div", { class: "stat-foot" }, h("span", { class: "skeleton", style: "width: 90px" })),
      ),
    ),
  );
}

async function load(root: HTMLElement) {
  const state: SnapshotState = {};
  try {
    const [dashboard, domains, senders, credentials, users, events] = await Promise.all([
      api.dashboard(),
      api.listDomains().catch(() => []),
      api.listSenders().catch(() => []),
      api.listSmtpCredentials().catch(() => []),
      api.listUsers().catch(() => []),
      api.listSendEvents().catch(() => []),
    ]);
    state.dashboard = dashboard;
    state.domains = domains;
    state.senders = senders;
    state.credentials = credentials;
    state.users = users;
    state.events = events;
  } catch (error) {
    paintError(root, error);
    return;
  }
  paint(root, state);
}

function paintError(root: HTMLElement, error: unknown) {
  const body = root.querySelector<HTMLElement>("#dashboard-body");
  if (!body) return;
  const message = error instanceof Error ? error.message : "Could not load dashboard.";
  setChildren(body, h("div", { class: "banner bad" }, icon("warn", 14), message));
}

function paint(root: HTMLElement, snapshot: SnapshotState) {
  const data = snapshot.dashboard!;
  const events = snapshot.events ?? [];
  const dashboardBody = root.querySelector<HTMLElement>("#dashboard-body");
  if (!dashboardBody) return;

  const checklist = firstRunChecklist(snapshot);

  setChildren(
    dashboardBody,
    statRow(data, events),
    checklist ?? false,
    healthCard(data),
    recentActivityCard(events),
  );
}

function statRow(data: DashboardData, events: SendEvent[]): HTMLElement {
  const totalMime = events.reduce((sum, event) => sum + (event.mime_size_bytes ?? 0), 0);
  return h(
    "div",
    { class: "stats" },
    statTile({
      label: "Sends · 24h",
      value: formatNumber(data.sends_24h.total),
      foot: `${formatNumber(data.sends_24h.accepted ?? 0)} accepted`,
    }),
    statTile({
      label: "Failed · 24h",
      value: formatNumber(data.sends_24h.failed ?? 0),
      foot: (data.sends_24h.failed ?? 0) > 0 ? "needs attention" : "all clear",
      tone: (data.sends_24h.failed ?? 0) > 0 ? "bad" : undefined,
    }),
    statTile({
      label: "Auth failures · 24h",
      value: formatNumber(data.auth_failures_24h),
      foot: data.auth_failures_24h > 0 ? "credentials or scans" : "no attempts",
      tone: data.auth_failures_24h > 5 ? "warn" : undefined,
    }),
    statTile({
      label: "MIME · 24h",
      value: formatBytes(totalMime),
      foot: "total relayed bytes",
      unit: undefined,
    }),
  );
}

function statTile(opts: { label: string; value: string; foot: string; unit?: string; tone?: "bad" | "warn" }): HTMLElement {
  return h(
    "div",
    { class: `stat${opts.tone ? ` is-${opts.tone}` : ""}` },
    h("div", { class: "stat-label" }, opts.label),
    h(
      "div",
      { class: "stat-value" },
      h("span", null, opts.value),
      opts.unit ? h("span", { class: "unit" }, opts.unit) : false,
    ),
    h("div", { class: "stat-foot" }, opts.foot),
  );
}

function healthCard(data: DashboardData): HTMLElement {
  const ok = data.cf_api_health.ok;
  const status = ok ? "Healthy" : data.cf_api_health.error_code ?? "Unhealthy";
  return h(
    "div",
    { class: "card" },
    h(
      "div",
      { class: "card-head" },
      h("h2", null, "Service health"),
      h("span", { class: "soft", style: "font-size: 12px" }, `Checked ${formatRelative(data.cf_api_health.checked_at)}`),
    ),
    h(
      "div",
      { class: "card-body" },
      h(
        "div",
        { class: "health-grid" },
        healthCell("Cloudflare API", ok ? "ok" : "bad", status),
        healthCell("Worker", "ok", "Responding"),
        healthCell("D1 reachability", "ok", "Reachable via Worker"),
        healthCell(
          "Last error",
          data.last_error ? "warn" : "muted",
          data.last_error ? "See events" : "None",
        ),
      ),
    ),
  );
}

function healthCell(label: string, kind: "ok" | "bad" | "warn" | "muted", value: string): HTMLElement {
  const className = kind === "muted" ? "pill muted" : `pill ${kind}`;
  return h(
    "div",
    { class: "health-item" },
    h("span", { class: "label" }, label),
    h("div", { class: "value" }, h("span", { class: className }, value)),
  );
}

function recentActivityCard(events: SendEvent[]): HTMLElement {
  const head = h(
    "div",
    { class: "card-head" },
    h("h2", null, "Recent activity"),
    h(
      "a",
      { href: "#/events", class: "btn ghost sm" },
      "View all",
      icon("arrowRight", 12),
    ),
  );
  if (events.length === 0) {
    return h(
      "div",
      { class: "card pad-0" },
      head,
      h(
        "div",
        { class: "empty" },
        h("div", { class: "empty-title" }, "No sends yet"),
        h("div", { class: "empty-sub" }, "Once your relay forwards a message, it lands here."),
      ),
    );
  }
  const list = h("div", { class: "stack", style: "gap: 0" });
  for (const event of events.slice(0, 8)) {
    list.appendChild(activityRow(event));
  }
  return h("div", { class: "card pad-0" }, head, list);
}

function activityRow(event: SendEvent): HTMLElement {
  const handler = () => navigate("/events", { id: event.id });
  return h(
    "button",
    {
      type: "button",
      class: "checklist-item",
      style: "background: transparent; cursor: pointer; padding: 11px 16px; border-bottom-color: var(--border);",
      "on:click": handler,
    },
    h(
      "span",
      { class: "marker", style: `background: ${dotBg(event.status)}; border-color: transparent; color: var(--accent-ink)` },
      "·",
    ),
    h(
      "span",
      { class: "label", style: "display: grid; gap: 2px" },
      h(
        "span",
        { class: "row", style: "gap: 8px" },
        eventStatusPill(event.status),
        h("span", { class: "id" }, event.envelope_from),
        h("span", { class: "soft", style: "font-size: 12px" }, "→ "),
        h("span", { class: "soft", style: "font-size: 12px" }, `${event.recipient_count} ${event.recipient_count === 1 ? "recipient" : "recipients"}`),
      ),
      h(
        "span",
        { class: "soft", style: "font-size: 12px; font-family: 'JetBrains Mono', monospace;" },
        `${formatShort(event.ts)} · ${event.id}`,
      ),
    ),
    h("span", { class: "go" }, icon("chevronRight", 12)) as Child,
  );
}

function dotBg(status: string): string {
  switch (eventStatusKind(status)) {
    case "ok":
      return "var(--ok)";
    case "bad":
      return "var(--bad)";
    case "warn":
      return "var(--warn)";
    default:
      return "var(--surface-3)";
  }
}

// ───────────────────────── First-run checklist ─────────────────────────

interface ChecklistStep {
  done: boolean;
  label: string;
  sub: string;
  href: string;
  cta?: string;
}

function firstRunChecklist(snapshot: SnapshotState): HTMLElement | null {
  const hasDomain = (snapshot.domains?.length ?? 0) > 0;
  const hasSender = (snapshot.senders?.length ?? 0) > 0;
  const hasCredential = (snapshot.credentials?.length ?? 0) > 0;
  const hasUser = (snapshot.users?.length ?? 1) > 0;
  if (hasDomain && hasSender && hasCredential) return null;

  const steps: ChecklistStep[] = [
    {
      done: true,
      label: "Bootstrap admin",
      sub: "Cloudflare Access is wired up — that's you.",
      href: "#/users",
    },
    {
      done: hasUser,
      label: "Invite a sender",
      sub: "Add a user who will own SMTP credentials.",
      href: "#/users?new=1",
      cta: "New user",
    },
    {
      done: hasDomain,
      label: "Add a sending domain",
      sub: "Email Sending must be verified for the domain in Cloudflare.",
      href: "#/domains?new=1",
      cta: "Add domain",
    },
    {
      done: hasSender,
      label: "Allow a sender address",
      sub: "Grant a user permission to send as a specific address (or *@domain).",
      href: "#/senders?new=1",
      cta: "Grant sender",
    },
    {
      done: hasCredential,
      label: "Create an SMTP credential",
      sub: "Create the SMTP username and password for a client or application.",
      href: "#/credentials?new=1",
      cta: "Create credential",
    },
  ];

  const ol = h("ol");
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    const marker = step.done ? icon("check", 12) : (i + 1).toString();
    const row = h(
      "a",
      { class: `checklist-item${step.done ? " done" : ""}`, href: step.done ? "#" : step.href },
      h("span", { class: "marker" }, marker),
      h(
        "span",
        { class: "label" },
        step.label,
        h("span", { class: "sub-label" }, step.sub),
      ),
      step.done
        ? h("span", { class: "go" }, "Done")
        : h("span", { class: "go" }, step.cta ?? "Open", icon("arrowRight", 12)),
    );
    ol.appendChild(row);
  }

  return h(
    "div",
    { class: "checklist" },
    h(
      "div",
      { class: "checklist-head" },
      h("h3", null, "Get started"),
      h("div", { class: "sub" }, "Three more steps until your relay can deliver mail."),
    ),
    ol,
  );
}
