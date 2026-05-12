import { api, describeError } from "../api";
import { h, icon, setChildren } from "../dom";
import { copyable } from "../clipboard";
import { recordRow, recordsFor } from "../dns";
import { formatAbsolute } from "../format";
import { buildForm, closeModal, openModal } from "../modal";
import { domainStatusKind, pill } from "../status";
import { toast } from "../toast";
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
      summaryCard(domain, root),
      // Senders before DNS — allowed senders is what operators check most;
      // DNS records are a reference you scan once and forget.
      sendersCard(domain, senders),
      dnsCard(domain),
    ),
  );
}

function summaryCard(domain: Domain, root: HTMLElement): HTMLElement {
  const enabled = domain.enabled === 1;
  return h(
    "div",
    { class: "card" },
    h(
      "div",
      { class: "card-head" },
      h("h2", null, "Summary"),
      h(
        "div",
        { class: "row", style: "gap: 6px" },
        h(
          "button",
          {
            type: "button",
            class: "btn ghost sm",
            "on:click": async () => {
              try {
                await api.refreshDomain(domain.id);
                toast("Domain refreshed from Cloudflare");
                await renderDomainDetail(root, domain.id);
              } catch (error) {
                toast(describeError(error, "Could not refresh domain"), "err");
              }
            },
          },
          "Refresh",
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn ghost sm",
            "on:click": () => openEditDomain(domain, () => renderDomainDetail(root, domain.id)),
          },
          "Edit",
        ),
        h(
          "button",
          {
            type: "button",
            class: enabled ? "btn ghost sm danger" : "btn ghost sm",
            "on:click": async () => {
              if (enabled && !confirm(`Disable ${domain.domain}? Active senders on this domain will be unable to send.`)) return;
              try {
                await api.updateDomain(domain.id, { enabled: !enabled });
                toast(`${domain.domain} ${enabled ? "disabled" : "enabled"}`);
                await renderDomainDetail(root, domain.id);
              } catch (error) {
                toast(describeError(error, "Could not update domain"), "err");
              }
            },
          },
          enabled ? "Disable" : "Enable",
        ),
      ),
    ),
    h(
      "div",
      { class: "card-body" },
      h(
        "dl",
        { class: "dl" },
        h("dt", null, "Status"), h("dd", null, pill(domain.status, domainStatusKind(domain.status))),
        h("dt", null, "Enabled"), h("dd", null, enabled ? pill("yes", "ok") : pill("no", "muted")),
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

function openEditDomain(domain: Domain, onSaved: () => void): void {
  const { form, setBanner, busy } = buildForm(
    [
      {
        name: "status",
        label: "Status",
        kind: "select",
        value: domain.status,
        options: [
          { value: "pending", label: "pending" },
          { value: "verified", label: "verified" },
          { value: "sandbox", label: "sandbox" },
          { value: "disabled", label: "disabled" },
        ],
        hint: "Track what Cloudflare Email Sending reports for this domain.",
      },
      {
        name: "cloudflare_zone_id",
        label: "Cloudflare Zone ID",
        value: domain.cloudflare_zone_id ?? "",
        hint: "Normally populated by Refresh from Cloudflare; edit only for repair.",
      },
    ],
    async (raw) => {
      setBanner(null);
      busy(true);
      try {
        await api.updateDomain(domain.id, {
          status: raw.status,
          cloudflare_zone_id: raw.cloudflare_zone_id.trim().length === 0 ? null : raw.cloudflare_zone_id,
        });
        toast("Domain updated");
        closeModal();
        onSaved();
      } catch (error) {
        setBanner(describeError(error, "Could not update domain."));
        busy(false);
      }
    },
  );
  const submit = h("button", { type: "submit", class: "btn primary" }, "Save");
  const cancel = h("button", { type: "button", class: "btn ghost", "on:click": () => closeModal() }, "Cancel");
  submit.addEventListener("click", () => form.requestSubmit());
  openModal({
    title: `Edit ${domain.domain}`,
    body: form,
    footer: h("div", { class: "row-between flex-fill" }, cancel, submit),
  });
}

function dnsCard(domain: Domain): HTMLElement {
  // <details> collapses by default. Operators rarely need to revisit DNS
  // records after the initial setup, and on mobile this section is the
  // bulkiest scroll.
  return h(
    "details",
    { class: "card" },
    h(
      "summary",
      null,
      h("h2", null, "DNS records"),
      h("span", { class: "card-chevron" }, icon("chevronDown", 14)),
    ),
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
