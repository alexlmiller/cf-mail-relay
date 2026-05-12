import type { CreateSecretResult } from "./types";

export function smtpSecretMeta(result: CreateSecretResult): Array<{ label: string; value: string; mono?: boolean }> {
  return [
    { label: "SMTP server", value: result.smtp_host ?? "Not set", mono: true },
    { label: "Port", value: String(result.smtp_port ?? 587), mono: true },
    { label: "Security", value: result.smtp_security ?? "STARTTLS", mono: true },
    { label: "Username", value: result.username ?? "", mono: true },
  ];
}

export function smtpSecretWarning(result: CreateSecretResult): string {
  const base = "Save this SMTP password now. We cannot show it again.";
  return result.smtp_host ? base : `${base} Set the SMTP server in Settings before giving this credential to a client.`;
}
