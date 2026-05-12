import { api } from "../api";
import type { Child } from "../dom";
import { h, icon, on, setChildren } from "../dom";
import { copyable } from "../clipboard";
import { copy } from "../toast";
import { explainError, formatAbsolute, formatBytes, formatRelative, formatShort, truncateMiddle } from "../format";
import {
  authFailureChips,
  eventStatusKind,
  eventStatusLabel,
  eventStatusPill,
  pill,
  sendEventChips,
} from "../status";
import { buildTable } from "../table";
import { openDrawer, close as closeDrawer } from "../drawer";
import { navigate, parse, replaceQuery, subscribe } from "../router";
import type { AuthFailure, SendEvent } from "../types";

type Mode = "sends" | "auth";

let cleanupSub: (() => void) | null = null;

export async function renderEvents(root: HTMLElement) {
  cleanupSub?.();
  const mode: Mode = parse().query.get("mode") === "auth" ? "auth" : "sends";

  setChildren(
    root,
    head(mode),
    h("div", { id: "events-table" }, h("div", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "skeleton" })))),
  );

  const { table, raw } = await loadTable(mode);
  const tableContainer = root.querySelector<HTMLElement>("#events-table");
  if (tableContainer) setChildren(tableContainer, table);

  // Subscribe to route changes for the drawer query param.
  cleanupSub = subscribe((route) => {
    if (route.name !== "events") return;
    const id = route.query.get("id");
    if (id && mode === "sends") {
      const event = raw.find((row) => "envelope_from" in row && row.id === id) as SendEvent | undefined;
      if (event) openSendDrawer(event);
    } else {
      closeDrawer();
    }
  });

  // Open drawer if the URL already has ?id=.
  const initialId = parse().query.get("id");
  if (initialId && mode === "sends") {
    const event = raw.find((row) => "envelope_from" in row && row.id === initialId) as SendEvent | undefined;
    if (event) openSendDrawer(event);
  }
}

function head(mode: Mode): HTMLElement {
  return h(
    "header",
    { class: "page-head" },
    h(
      "div",
      null,
      h(
        "div",
        { class: "crumbs" },
        h("a", { href: "#/" }, "—"),
        h("span", { class: "sep" }, "/"),
        h("span", null, "events"),
      ),
      h("h1", null, "Events"),
    ),
    h(
      "div",
      { class: "actions" },
      h(
        "div",
        { class: "row", style: "gap: 0; border: 1px solid var(--border); border-radius: var(--radius-1); padding: 2px;" },
        modeBtn("Sends", mode === "sends", () => navigate("/events", { mode: "sends" })),
        modeBtn("Auth failures", mode === "auth", () => navigate("/events", { mode: "auth" })),
      ),
    ),
  );
}

function modeBtn(label: string, active: boolean, onClick: () => void): HTMLElement {
  return h(
    "button",
    {
      type: "button",
      class: `btn sm ghost${active ? " primary" : ""}`,
      style: active ? "background: var(--surface-3); color: var(--text); border: 0" : "border: 0",
      "on:click": onClick,
    },
    label,
  );
}

async function loadTable(mode: Mode): Promise<{ table: HTMLElement; raw: Array<SendEvent | AuthFailure> }> {
  if (mode === "auth") {
    const rows = await api.listAuthFailures();
    return { table: authFailureTable(rows), raw: rows };
  }
  const events = await api.listSendEvents();
  return { table: sendEventTable(events), raw: events };
}

function sendEventTable(events: SendEvent[]): HTMLElement {
  const built = buildTable<SendEvent>({
    columns: [
      {
        key: "ts",
        label: "Time",
        render: (row) =>
          h(
            "span",
            { class: "mono num", title: formatAbsolute(row.ts) },
            formatShort(row.ts),
          ),
        sort: (row) => row.ts,
        width: 130,
      },
      {
        key: "status",
        label: "Status",
        render: (row) => eventStatusPill(row.status),
        sort: (row) => row.status,
        width: 150,
      },
      {
        key: "source",
        label: "Src",
        render: (row) => h("span", { class: "soft uppercase", style: "font-size: 11px" }, row.source),
        sort: (row) => row.source,
        width: 50,
      },
      {
        key: "from",
        label: "From",
        render: (row) => h("span", { class: "id" }, row.envelope_from),
        sort: (row) => row.envelope_from,
      },
      {
        key: "count",
        label: "Recipients",
        right: true,
        render: (row) => h("span", { class: "num" }, String(row.recipient_count)),
        sort: (row) => row.recipient_count,
        width: 110,
      },
      {
        key: "size",
        label: "Size",
        right: true,
        render: (row) => h("span", { class: "mono num" }, formatBytes(row.mime_size_bytes)),
        sort: (row) => row.mime_size_bytes,
        width: 90,
      },
      {
        key: "smtp",
        label: "SMTP",
        right: true,
        render: (row) => h("span", { class: "mono num" }, row.smtp_code ?? "—"),
        sort: (row) => row.smtp_code ?? "",
        width: 70,
      },
      {
        key: "id",
        label: "ID",
        cell: "mono",
        render: (row) => copyable({ value: row.id, display: truncateMiddle(row.id, 8, 4), title: row.id }),
        width: 130,
      },
    ],
    rows: events,
    defaultSort: { key: "ts", dir: "desc" },
    chips: sendEventChips,
    chipValue: (row) => row.status,
    search: (row) => `${row.envelope_from} ${row.id} ${row.credential_id ?? ""} ${row.api_key_id ?? ""} ${row.status} ${row.error_code ?? ""}`,
    searchPlaceholder: "Search by sender, ID, status, error…",
    onRowClick: (row) => navigate("/events", { mode: "sends", id: row.id }),
    emptyTitle: "No send events yet",
    emptyHint: "Once a message flows through the relay, it's recorded here. Try `pnpm doctor:delivery` once your relay is up.",
    cardMode: true,
  });
  return built.root;
}

function authFailureTable(rows: AuthFailure[]): HTMLElement {
  const built = buildTable<AuthFailure>({
    columns: [
      {
        key: "ts",
        label: "Time",
        render: (row) => h("span", { class: "mono num", title: formatAbsolute(row.ts) }, formatShort(row.ts)),
        sort: (row) => row.ts,
        width: 150,
      },
      {
        key: "username",
        label: "Username",
        render: (row) => h("span", { class: "id" }, row.attempted_username ?? "—"),
        sort: (row) => row.attempted_username ?? "",
      },
      {
        key: "reason",
        label: "Reason",
        render: (row) => pill(reasonLabel(row.reason), reasonKind(row.reason)),
        sort: (row) => row.reason ?? "",
        width: 160,
      },
      {
        key: "source",
        label: "Source",
        render: (row) => sourcePill(row.source),
        sort: (row) => row.source,
        width: 110,
      },
      {
        key: "id",
        label: "ID",
        cell: "mono",
        render: (row) => copyable({ value: row.id, display: truncateMiddle(row.id, 8, 4), title: row.id }),
        width: 130,
      },
    ],
    rows,
    defaultSort: { key: "ts", dir: "desc" },
    chips: authFailureChips,
    chipValue: (row) => `${row.source}:${row.reason ?? ""}`,
    search: (row) => `${row.attempted_username ?? ""} ${row.reason ?? ""} ${row.source}`,
    searchPlaceholder: "Search by username or reason…",
    emptyTitle: "No authentication failures",
    emptyHint: "If someone tries to AUTH with a bad username or password, it'll land here.",
    cardMode: true,
  });
  return built.root;
}

function sourcePill(source: string): HTMLElement {
  switch (source) {
    case "bootstrap":
      return pill("bootstrap", "warn", "Failed bootstrap-admin attempt — investigate the source IP");
    case "smtp":
      return pill("smtp", "muted");
    case "http":
      return pill("http", "muted");
    default:
      return h("span", { class: "uppercase soft", style: "font-size: 11px" }, source);
  }
}

function reasonLabel(reason: string | null): string {
  switch (reason) {
    case "bad_creds": return "Bad credentials";
    case "disabled": return "Credential disabled";
    case "not_found": return "Unknown user";
    case "tls_required": return "TLS required";
    case "throttled": return "Throttled";
    default: return reason ?? "—";
  }
}
function reasonKind(reason: string | null): "bad" | "warn" | "muted" {
  if (reason === "throttled") return "warn";
  if (reason === "disabled") return "muted";
  return "bad";
}

// ───────────────────────── Drawer ─────────────────────────

function openSendDrawer(event: SendEvent) {
  const drawerBody = h("div", { class: "stack", style: "gap: 18px" });

  drawerBody.appendChild(
    h(
      "div",
      { class: "row", style: "gap: 10px" },
      eventStatusPill(event.status),
      h("span", { class: "soft", style: "font-size: 13px" }, formatAbsolute(event.ts)),
      h("span", { class: "soft", style: "font-size: 12px" }, `(${formatRelative(event.ts)})`),
    ),
  );

  if (eventStatusKind(event.status) !== "ok") {
    const explanation = explainError(event.error_code) === "—" && event.cf_error_code
      ? explainError(event.cf_error_code)
      : explainError(event.error_code);
    drawerBody.appendChild(
      h(
        "div",
        { class: `banner ${eventStatusKind(event.status) === "warn" ? "warn" : "bad"}` },
        icon("warn", 14),
        h(
          "div",
          { class: "stack", style: "gap: 4px" },
          h("strong", null, eventStatusLabel(event.status)),
          h("span", null, explanation),
        ),
      ),
    );
  }

  // Definition list
  const dl = h("dl", { class: "dl" });
  dlRow(dl, "Trace", copyable({ value: event.trace_id, display: event.trace_id }));
  dlRow(dl, "Source", h("span", { class: "uppercase mono" }, event.source));
  dlRow(dl, "From", h("span", { class: "id" }, event.envelope_from));
  dlRow(dl, "Recipients", h("span", { class: "num" }, String(event.recipient_count)));
  dlRow(dl, "MIME size", h("span", { class: "mono num" }, formatBytes(event.mime_size_bytes)));
  if (event.smtp_code) dlRow(dl, "SMTP code", h("span", { class: "mono num" }, event.smtp_code));
  if (event.credential_id) dlRow(dl, "Credential", copyable({ value: event.credential_id, display: event.credential_id }));
  if (event.api_key_id) dlRow(dl, "API key", copyable({ value: event.api_key_id, display: event.api_key_id }));
  if (event.cf_request_id) dlRow(dl, "CF request ID", copyable({ value: event.cf_request_id, display: event.cf_request_id }));
  if (event.cf_ray_id) dlRow(dl, "CF Ray", copyable({ value: event.cf_ray_id, display: event.cf_ray_id }));
  if (event.error_code) dlRow(dl, "Error code", h("span", { class: "mono" }, event.error_code));
  if (event.cf_error_code) dlRow(dl, "CF error", h("span", { class: "mono" }, event.cf_error_code));
  dlRow(dl, "Event ID", copyable({ value: event.id, display: event.id }));
  drawerBody.appendChild(dl);

  drawerBody.appendChild(h("div", { class: "section-title" }, "Raw event"));
  drawerBody.appendChild(h("pre", { class: "json" }, JSON.stringify(event, null, 2)));

  const footer = h(
    "div",
    { class: "row-between flex-fill" },
    h(
      "div",
      { class: "soft", style: "font-size: 12px" },
      `Event ${truncateMiddle(event.id, 6, 4)}`,
    ),
    h(
      "div",
      { class: "row" },
      h(
        "button",
        {
          type: "button",
          class: "btn ghost sm",
          "on:click": () => copy(JSON.stringify(event, null, 2), "Event JSON copied"),
        },
        icon("copy", 12),
        "Copy JSON",
      ),
      h(
        "button",
        {
          type: "button",
          class: "btn sm",
          "on:click": () => {
            closeDrawer();
            replaceQuery({ id: undefined });
          },
        },
        "Close",
      ),
    ),
  );

  openDrawer({
    title: "Send event",
    crumbs: [h("a", { href: "#/events" }, "events"), h("span", { class: "sep" }, "/"), h("span", null, truncateMiddle(event.id, 8, 4))],
    body: drawerBody,
    footer,
    onClose: () => replaceQuery({ id: undefined }),
  });
}

function dlRow(dl: HTMLElement, label: string, value: Child) {
  dl.appendChild(h("dt", null, label));
  dl.appendChild(h("dd", null, value));
}

// Re-export so other modules can re-render after creating new rows.
export async function refreshEvents(root: HTMLElement) {
  await renderEvents(root);
}

// Maintenance: keep linter happy with unused imports.
void on;
