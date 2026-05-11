import { api } from "../api";
import { h, icon, setChildren } from "../dom";
import { copyable } from "../clipboard";
import { recordRow, recordsFor } from "../dns";
import { formatAbsolute } from "../format";
import { domainStatusKind, pill } from "../status";
import { navigate } from "../router";
import type { Domain, Sender } from "../types";

export async function renderDomainDetail(root: HTMLElement, id: string) {
  setChildren(
    root,
    head(null),
    h("div", { id: "domain-detail-body" }, h("div", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "skeleton" })))),
  );

  let domain: Domain | undefined;
  let senders: Sender[] = [];
  try {
    const [domains, allSenders] = await Promise.all([api.listDomains(), api.listSenders()]);
    domain = domains.find((d) => d.id === id);
    senders = allSenders.filter((s) => s.domain_id === id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load domain.";
    const body = root.querySelector<HTMLElement>("#domain-detail-body");
    if (body) setChildren(body, h("div", { class: "banner bad" }, icon("warn", 14), message));
    return;
  }

  if (!domain) {
    notFound(root);
    return;
  }

  paint(root, domain, senders);
}

function head(domain: Domain | null): HTMLElement {
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
        h("a", { href: "#/domains" }, "domains"),
        h("span", { class: "sep" }, "/"),
        h("span", null, domain?.domain ?? "…"),
      ),
      h("h1", null, domain?.domain ?? "Domain"),
    ),
    h(
      "div",
      { class: "actions" },
      h("a", { href: "#/domains", class: "btn ghost" }, "Back"),
    ),
  );
}

function notFound(root: HTMLElement) {
  setChildren(
    root,
    head(null),
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "empty" },
        h("div", { class: "empty-title" }, "Domain not found"),
        h("div", { class: "empty-sub" }, "It may have been removed, or the link is stale."),
        h("div", { class: "empty-actions" }, h("a", { class: "btn", href: "#/domains" }, "Back to domains")),
      ),
    ),
  );
}

function paint(root: HTMLElement, domain: Domain, senders: Sender[]) {
  setChildren(
    root,
    head(domain),
    h(
      "div",
      { class: "spread" },
      summaryCard(domain),
      dnsCard(domain),
      sendersCard(domain, senders),
    ),
  );
}

function summaryCard(domain: Domain): HTMLElement {
  return h(
    "div",
    { class: "card" },
    h("div", { class: "card-head" }, h("h2", null, "Summary")),
    h(
      "div",
      { class: "card-body" },
      h(
        "dl",
        { class: "dl" },
        h("dt", null, "Status"), h("dd", null, pill(domain.status, domainStatusKind(domain.status))),
        h("dt", null, "Domain"), h("dd", null, copyable({ value: domain.domain, display: domain.domain })),
        h("dt", null, "Zone ID"), h("dd", null, domain.cloudflare_zone_id ? copyable({ value: domain.cloudflare_zone_id }) : h("span", { class: "soft" }, "—")),
        h("dt", null, "DKIM"), h("dd", null, domain.dkim_status ? h("span", { class: "mono" }, domain.dkim_status) : h("span", { class: "soft" }, "—")),
        h("dt", null, "SPF"), h("dd", null, domain.spf_status ? h("span", { class: "mono" }, domain.spf_status) : h("span", { class: "soft" }, "—")),
        h("dt", null, "DMARC"), h("dd", null, domain.dmarc_status ? h("span", { class: "mono" }, domain.dmarc_status) : h("span", { class: "soft" }, "—")),
        h("dt", null, "Created"), h("dd", { class: "soft" }, formatAbsolute(domain.created_at)),
        h("dt", null, "Updated"), h("dd", { class: "soft" }, formatAbsolute(domain.updated_at)),
      ),
    ),
  );
}

function dnsCard(domain: Domain): HTMLElement {
  return h(
    "div",
    { class: "card" },
    h("div", { class: "card-head" }, h("h2", null, "DNS records")),
    h(
      "div",
      { class: "card-body" },
      h(
        "div",
        { class: "banner" },
        icon("info", 14),
        "Cloudflare publishes the actual selectors when Email Sending is enabled for the domain. The records below are the template — replace the DKIM selector with what the Cloudflare dashboard shows.",
      ),
      h("div", { style: "margin-top: 12px" }, ...recordsFor(domain.domain).map(recordRow)),
    ),
  );
}

function sendersCard(domain: Domain, senders: Sender[]): HTMLElement {
  const head = h(
    "div",
    { class: "card-head" },
    h("h2", null, `Allowed senders · ${senders.length}`),
    h(
      "a",
      { class: "btn ghost sm", href: `#/senders?new=1&domain=${encodeURIComponent(domain.id)}` },
      icon("plus", 12),
      "Grant sender",
    ),
  );

  if (senders.length === 0) {
    return h(
      "div",
      { class: "card pad-0" },
      head,
      h(
        "div",
        { class: "empty" },
        h("div", { class: "empty-title" }, "No allowed senders for this domain"),
        h("div", { class: "empty-sub" }, "Grant a user permission to send as a specific address, or use *@domain to allow any address on the domain."),
        h(
          "div",
          { class: "empty-actions" },
          h("a", { class: "btn primary", href: `#/senders?new=1&domain=${encodeURIComponent(domain.id)}` }, icon("plus", 12), "Grant sender"),
        ),
      ),
    );
  }

  const list = h("div", { class: "stack", style: "gap: 0" });
  for (const sender of senders) {
    list.appendChild(senderRow(sender));
  }
  return h("div", { class: "card pad-0" }, head, list);
}

function senderRow(sender: Sender): HTMLElement {
  return h(
    "div",
    { class: "row-between", style: "padding: 12px 16px; border-bottom: 1px solid var(--border)" },
    h(
      "div",
      { class: "row", style: "gap: 10px" },
      icon("user", 13),
      h("span", { class: "id", style: "font-size: 13.5px; color: var(--text)" }, sender.email),
      sender.user_email
        ? h("span", { class: "soft", style: "font-size: 12px" }, `→ ${sender.user_email}`)
        : h("span", { class: "soft", style: "font-size: 12px" }, "→ any user"),
    ),
    sender.enabled ? pill("enabled", "ok") : pill("disabled", "muted"),
  );
}

// Keep navigate import live for future use.
void navigate;
