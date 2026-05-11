// DNS record helpers for domain detail. Records are illustrative — the actual
// CNAME/TXT values are issued by Cloudflare when Email Sending is enabled for
// the domain.

import type { Child } from "./dom";
import { h } from "./dom";
import { copyable } from "./clipboard";

export interface DnsRecord {
  type: "MX" | "TXT" | "CNAME";
  name: string;
  value: string;
  ttl?: string;
  hint?: string;
}

export function recordsFor(domain: string): DnsRecord[] {
  return [
    {
      type: "MX",
      name: `cf-bounce.${domain}`,
      value: "10  route.mx.cloudflare.net.",
      hint: "Bounce host for Cloudflare Email Sending. Provisioned by Cloudflare when Email Sending is enabled.",
    },
    {
      type: "TXT",
      name: `cf-bounce.${domain}`,
      value: `v=spf1 include:_spf.mx.cloudflare.net ~all`,
      hint: "SPF record on the bounce host. Lets recipients verify the return-path.",
    },
    {
      type: "CNAME",
      name: `cf2024-1._domainkey.${domain}`,
      value: `cf2024-1._domainkey.mail.cloudflare.net.`,
      hint: "DKIM selector. Cloudflare publishes the actual selector when Email Sending is enabled for the domain — copy the published one from the Cloudflare dashboard.",
    },
    {
      type: "TXT",
      name: `_dmarc.${domain}`,
      value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
      hint: "Start at p=none. Escalate to quarantine / reject after doctor:delivery confirms alignment.",
    },
  ];
}

export function recordRow(record: DnsRecord): HTMLElement {
  return h(
    "div",
    { class: "dns-record" },
    h("div", { class: "type" }, h("span", { class: "pill-static" }, record.type)),
    h(
      "div",
      { class: "value" },
      h("div", { class: "name" }, record.name),
      copyable({ value: record.value, withIcon: true, stopPropagation: false }),
      record.hint ? h("div", { class: "soft", style: "margin-top: 4px; font-family: 'General Sans', sans-serif; font-size: 12px;" }, record.hint) : false,
    ) as Child,
    copyable({ value: `${record.name}\t${record.type}\t${record.value}`, display: "Copy line", withIcon: false, stopPropagation: false }) as Child,
  );
}
