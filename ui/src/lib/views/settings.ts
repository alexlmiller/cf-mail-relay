// Relay-wide settings: SMTP client connection details + sending-domain
// management. Single page that consolidates the two pieces of global config
// admins touch most often.

import { api, describeError } from "../api";
import type { Child } from "../dom";
import { h, icon, on, setChildren } from "../dom";
import { domainStatusKind, pill } from "../status";
import { toast } from "../toast";
import { openNewDomain } from "./domains";
import type { AppSettings, Domain } from "../types";

interface Snapshot {
  settings: AppSettings;
  domains: Domain[];
}

export async function renderSettings(root: HTMLElement) {
  setChildren(
    root,
    head(),
    h("div", { id: "settings-body", class: "stack", style: "gap: 18px" },
      h("div", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "skeleton" }))),
      h("div", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "skeleton" }))),
    ),
  );

  try {
    const [settings, domains] = await Promise.all([api.getSettings(), api.listDomains().catch(() => [])]);
    paint(root, { settings, domains });
  } catch (error) {
    const target = root.querySelector<HTMLElement>("#settings-body");
    if (target) setChildren(target, h("div", { class: "banner bad" }, icon("warn", 14), describeError(error, "Could not load settings.")));
  }
}

function head(): HTMLElement {
  return h(
    "header",
    { class: "page-head" },
    h(
      "div",
      null,
      h("div", { class: "crumbs" }, h("a", { href: "#/" }, "—"), h("span", { class: "sep" }, "/"), h("span", null, "settings")),
      h("h1", null, "Settings"),
      h(
        "div",
        { class: "soft", style: "margin-top: 6px; font-size: 13px; max-width: 64ch" },
        "Relay-wide configuration: how SMTP clients connect, and which domains are authorised to send.",
      ),
    ),
    h("div", { class: "actions" }),
  );
}

function paint(root: HTMLElement, snapshot: Snapshot) {
  const target = root.querySelector<HTMLElement>("#settings-body");
  if (!target) return;
  setChildren(
    target,
    smtpCard(root, snapshot),
    domainsCard(root, snapshot),
  );
}

// ───────────────────────── SMTP card ─────────────────────────

function smtpCard(root: HTMLElement, snapshot: Snapshot): HTMLElement {
  const { settings } = snapshot;
  const input = h("input", {
    type: "text",
    name: "smtp_host",
    value: settings.smtp_host ?? "",
    placeholder: "smtp.example.com",
    autocomplete: "off",
    spellcheck: false,
  }) as HTMLInputElement;

  const banner = h("div", { class: "stack", style: "gap: 6px" });
  let saving = false;

  const submit = h(
    "button",
    {
      type: "submit",
      class: "btn primary",
    },
    "Save",
  );

  const form = h(
    "form",
    {
      class: "stack",
      style: "gap: 12px",
    },
    h(
      "div",
      { class: "field" },
      h("label", { for: "smtp_host" }, "Hostname"),
      h(
        "div",
        { class: "row", style: "gap: 8px; align-items: stretch" },
        h("div", { class: "input", style: "flex: 1 1 auto" }, input),
        submit,
      ),
      h(
        "div",
        { class: "hint" },
        "Clients use this hostname on port ",
        h("span", { class: "mono" }, "587"),
        " with ",
        h("span", { class: "mono" }, "STARTTLS"),
        ".",
      ),
    ),
    banner,
  );

  on(form, "submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    submit.setAttribute("disabled", "true");
    setChildren(banner);
    try {
      const next = await api.updateSettings({ smtp_host: input.value.trim().length === 0 ? null : input.value.trim() });
      toast("SMTP server saved");
      paint(root, { ...snapshot, settings: next });
    } catch (error) {
      submit.removeAttribute("disabled");
      saving = false;
      setChildren(banner, h("div", { class: "banner bad" }, icon("warn", 14), describeError(error, "Could not save.")));
    }
  });

  return h(
    "div",
    { class: "card" },
    h(
      "div",
      { class: "card-head" },
      h("div", null, h("h2", null, "SMTP server")),
    ),
    h("div", { class: "card-body" }, form),
  );
}

// ───────────────────────── Domains card ─────────────────────────

function domainsCard(root: HTMLElement, snapshot: Snapshot): HTMLElement {
  const { domains } = snapshot;
  const verified = domains.filter((d) => d.status === "verified").length;
  const pending = domains.filter((d) => d.status === "pending").length;
  const disabled = domains.filter((d) => d.enabled === 0).length;

  const head = h(
    "div",
    { class: "card-head" },
    h(
      "h2",
      null,
      "Sending domains",
      h("span", { class: "soft", style: "margin-left: 10px; font-weight: 400; font-size: 13px" }, `· ${domains.length}`),
    ),
    h(
      "div",
      { class: "row", style: "gap: 8px" },
      h(
        "button",
        {
          type: "button",
          class: "btn primary sm",
          "on:click": () => openNewDomain(() => void reload(root)),
        },
        icon("plus", 12),
        "Add domain",
      ),
    ),
  );

  if (domains.length === 0) {
    return h(
      "div",
      { class: "card pad-0" },
      head,
      h(
        "div",
        { class: "empty" },
        h("div", { class: "empty-title" }, "No sending domains yet"),
        h("div", { class: "empty-sub" }, "Enable Cloudflare Email Sending for a domain in your account, then add it here. The relay refuses to send From an unknown domain."),
        h(
          "div",
          { class: "empty-actions" },
          h(
            "button",
            { type: "button", class: "btn primary", "on:click": () => openNewDomain(() => void reload(root)) },
            icon("plus", 12),
            "Add the first domain",
          ),
        ),
      ),
    );
  }

  const stats = h(
    "div",
    { class: "row", style: "gap: 18px; padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 13px; flex-wrap: wrap" },
    statBadge("verified", verified, "ok"),
    statBadge("pending", pending, pending > 0 ? "warn" : "muted"),
    statBadge("disabled", disabled, "muted"),
  );

  const list = h("div", { class: "compact-list" });
  for (const domain of domains) {
    list.appendChild(domainRow(domain));
  }

  return h("div", { class: "card pad-0" }, head, stats, list);
}

function statBadge(label: string, count: number, tone: "ok" | "warn" | "muted"): Child {
  const color = tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--warn)" : "var(--text-faint)";
  return h(
    "span",
    { class: "row", style: "gap: 6px; align-items: center" },
    h("span", { style: `display:inline-block;width:8px;height:8px;border-radius:99px;background:${color}` }),
    h("span", { class: "mono num", style: "color: var(--text); font-weight: 500" }, String(count)),
    h("span", { class: "soft" }, label),
  );
}

function domainRow(domain: Domain): HTMLElement {
  return h(
    "a",
    {
      href: `#/domains/${domain.id}`,
      class: "compact-row",
      style: "text-decoration: none",
    },
    h(
      "span",
      { class: "marker", style: "width: 14px; height: 14px; border-radius: 4px; display: grid; place-items: center; background: transparent; color: var(--text-mute)" },
      icon("globe", 12),
    ),
    h(
      "span",
      { class: "label" },
      h("span", { class: "primary" }, h("span", { class: "id", style: "color: var(--text)" }, domain.domain), pill(domain.status, domainStatusKind(domain.status)), domain.enabled === 0 ? pill("disabled", "muted") : false),
      h(
        "span",
        { class: "secondary" },
        domain.cloudflare_zone_id ?? "—",
      ),
    ),
    h("span", { class: "go" }, icon("chevronRight", 12)),
  );
}

async function reload(root: HTMLElement): Promise<void> {
  await renderSettings(root);
}
