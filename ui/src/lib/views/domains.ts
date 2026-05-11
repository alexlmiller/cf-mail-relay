import { api, describeError } from "../api";
import type { Child } from "../dom";
import { h, icon, setChildren } from "../dom";
import { copyable } from "../clipboard";
import { formatDayOnly } from "../format";
import { toast } from "../toast";
import { domainStatusKind, pill } from "../status";
import { buildTable } from "../table";
import { navigate, parse, replaceQuery } from "../router";
import { buildForm, closeModal, openModal } from "../modal";
import type { Domain } from "../types";

export async function renderDomains(root: HTMLElement) {
  setChildren(
    root,
    head(),
    h("div", { id: "domains-table" }, h("div", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "skeleton" })))),
  );

  let domains: Domain[] = [];
  try {
    domains = await api.listDomains();
  } catch (error) {
    paintError(root, error);
    return;
  }
  paint(root, domains);

  if (parse().query.get("new") === "1") {
    replaceQuery({ new: undefined });
    openNewDomain(() => renderDomains(root));
  }
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
        h("a", { href: "#/" }, "—"),
        h("span", { class: "sep" }, "/"),
        h("span", null, "domains"),
      ),
      h("h1", null, "Domains"),
    ),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          type: "button",
          class: "btn primary",
          "on:click": () => openNewDomain(() => navigate("/domains")),
        },
        icon("plus", 13),
        "Add domain",
      ),
    ),
  );
}

function paint(root: HTMLElement, domains: Domain[]) {
  const target = root.querySelector<HTMLElement>("#domains-table");
  if (!target) return;
  const built = buildTable<Domain>({
    columns: [
      {
        key: "domain",
        label: "Domain",
        render: (row) => h("span", { class: "row", style: "gap: 8px" }, icon("globe", 13), h("span", { class: "id", style: "font-size: 13px; color: var(--text)" }, row.domain)),
        sort: (row) => row.domain,
      },
      {
        key: "status",
        label: "Status",
        render: (row) => pill(row.status, domainStatusKind(row.status)),
        sort: (row) => row.status,
        width: 130,
      },
      {
        key: "zone",
        label: "Zone",
        render: (row) =>
          row.cloudflare_zone_id
            ? copyable({ value: row.cloudflare_zone_id, display: row.cloudflare_zone_id, withIcon: true })
            : h("span", { class: "soft" }, "—"),
        cell: "mono",
        sort: (row) => row.cloudflare_zone_id ?? "",
        width: 220,
      },
      {
        key: "enabled",
        label: "Enabled",
        render: (row) => (row.enabled ? pill("Enabled", "ok") : pill("Disabled", "muted")),
        sort: (row) => (row.enabled ? 1 : 0),
        width: 110,
      },
      {
        key: "created",
        label: "Created",
        render: (row) => h("span", { class: "mono num soft" }, formatDayOnly(row.created_at)),
        sort: (row) => row.created_at,
        width: 130,
      },
    ],
    rows: domains,
    defaultSort: { key: "created", dir: "desc" },
    search: (row) => `${row.domain} ${row.cloudflare_zone_id ?? ""} ${row.status}`,
    searchPlaceholder: "Search domains…",
    onRowClick: (row) => navigate(`/domains/${row.id}`),
    emptyTitle: "No sending domains",
    emptyHint: "Add the first domain you've enabled in Cloudflare Email Sending — the relay refuses to send From an unknown domain.",
    emptyAction: h(
      "button",
      {
        type: "button",
        class: "btn primary",
        "on:click": () => openNewDomain(() => renderDomains(root)),
      },
      icon("plus", 13),
      "Add domain",
    ) as Child,
  });
  setChildren(target, built.root);
}

function paintError(root: HTMLElement, error: unknown) {
  const target = root.querySelector<HTMLElement>("#domains-table");
  if (!target) return;
  const message = error instanceof Error ? error.message : "Could not load domains.";
  setChildren(target, h("div", { class: "banner bad" }, icon("warn", 14), message));
}

export function openNewDomain(onCreated: (id: string) => void) {
  const { form, values, setError, setBanner, busy } = buildForm(
    [
      { name: "domain", label: "Domain", placeholder: "example.com", required: true, hint: "The full apex you'll send mail from." },
      { name: "cloudflare_zone_id", label: "Cloudflare Zone ID", placeholder: "(optional)", hint: "Available in Cloudflare → DNS for the zone." },
      {
        name: "status",
        label: "Initial status",
        kind: "select",
        value: "pending",
        options: [
          { value: "pending", label: "pending" },
          { value: "verified", label: "verified" },
          { value: "sandbox", label: "sandbox" },
          { value: "disabled", label: "disabled" },
        ],
        hint: "Cloudflare Email Sending decides the real status; pick what reflects the dashboard.",
      },
    ],
    async (raw) => {
      setError("domain", null);
      setBanner(null);
      if (!raw.domain) {
        setError("domain", "Domain is required.");
        return;
      }
      busy(true);
      try {
        const result = await api.createDomain({
          domain: raw.domain,
          cloudflare_zone_id: raw.cloudflare_zone_id || undefined,
          status: raw.status,
        });
        toast(`Domain ${raw.domain} added`);
        closeModal();
        onCreated(result.id);
      } catch (error) {
        const message = describeError(error, "Could not create domain.");
        setBanner(message);
        busy(false);
      }
    },
  );

  const submit = h(
    "button",
    { type: "submit", class: "btn primary" },
    "Add domain",
  );
  const cancel = h(
    "button",
    { type: "button", class: "btn ghost", "on:click": () => closeModal() },
    "Cancel",
  );
  form.appendChild(h("div", { style: "display:none" }));

  openModal({
    title: "Add sending domain",
    body: h(
      "div",
      { class: "stack", style: "gap: 14px" },
      h("div", { class: "banner" }, icon("info", 14), "Email Sending must be enabled and verified for this domain in your Cloudflare account."),
      form,
    ),
    footer: h("div", { class: "row-between flex-fill" }, cancel, submit),
  });

  // Wire submit button to the form
  submit.addEventListener("click", () => form.requestSubmit());
  void values;
}
