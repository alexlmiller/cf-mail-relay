// Status pill rendering, status taxonomy, and filter helpers.

import { h } from "./dom";
import type { SendEventStatus } from "./types";

export type PillKind = "ok" | "bad" | "warn" | "info" | "muted" | "neutral";

export function eventStatusKind(status: string): PillKind {
  switch (status) {
    case "accepted":
      return "ok";
    case "all_bounced":
    case "cf_error":
    case "rejected_8bit":
    case "rejected_size":
    case "rejected_auth":
    case "rejected_allowlist":
    case "rejected_rcpt_cap":
      return "bad";
    case "policy_rejected":
    case "rate_limited":
      return "warn";
    default:
      return "neutral";
  }
}

export function eventStatusLabel(status: string): string {
  switch (status) {
    case "accepted": return "Accepted";
    case "all_bounced": return "All bounced";
    case "cf_error": return "Cloudflare error";
    case "policy_rejected": return "Policy rejected";
    case "rejected_8bit": return "8-bit rejected";
    case "rejected_size": return "Too large";
    case "rejected_auth": return "Auth rejected";
    case "rejected_allowlist": return "Allowlist";
    case "rejected_rcpt_cap": return "Recipient cap";
    case "rate_limited": return "Rate limited";
    default: return status;
  }
}

export function domainStatusKind(status: string): PillKind {
  switch (status) {
    case "verified": return "ok";
    case "sandbox": return "warn";
    case "pending": return "info";
    case "disabled": return "muted";
    default: return "neutral";
  }
}

export function pill(label: string, kind: PillKind = "neutral", title?: string): HTMLElement {
  const className = kind === "neutral" ? "pill muted" : `pill ${kind}`;
  return h("span", { class: className, title }, label);
}

export function eventStatusPill(status: SendEventStatus): HTMLElement {
  return pill(eventStatusLabel(status), eventStatusKind(status), status);
}

export interface FilterChip {
  key: string;
  label: string;
  match: (status: string) => boolean;
}

export const sendEventChips: FilterChip[] = [
  { key: "all", label: "All", match: () => true },
  { key: "accepted", label: "Accepted", match: (s) => s === "accepted" },
  { key: "failed", label: "Failed", match: (s) => eventStatusKind(s) === "bad" },
  { key: "policy", label: "Policy", match: (s) => s === "policy_rejected" || s === "rejected_allowlist" },
  { key: "rate", label: "Rate-limited", match: (s) => s === "rate_limited" },
];

export const authFailureChips: FilterChip[] = [
  { key: "all", label: "All", match: () => true },
  { key: "bad_creds", label: "Bad creds", match: (s) => s === "bad_creds" },
  { key: "disabled", label: "Disabled", match: (s) => s === "disabled" },
  { key: "not_found", label: "Unknown user", match: (s) => s === "not_found" },
];
