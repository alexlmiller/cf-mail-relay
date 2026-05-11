// Self-service page for any signed-in user (admin or sender). Single page;
// surfaces profile, granted senders (read-only), SMTP credentials (CRUD),
// API keys (CRUD), and recent activity (read-only, server-filtered by user_id).

import { ApiError } from "../api";
import { selfApi, type SelfProfile, type SelfSender } from "../api-self";
import type { Child } from "../dom";
import { h, icon, setChildren } from "../dom";
import { copyable } from "../clipboard";
import { copy, toast } from "../toast";
import { formatAbsolute, formatBytes, formatRelative, formatShort, initialsFor, truncateMiddle } from "../format";
import { buildForm, closeModal, openModal, secretRevealBody } from "../modal";
import { eventStatusKind, eventStatusLabel, eventStatusPill, pill } from "../status";
import { openDrawer, close as closeDrawer } from "../drawer";
import { replaceQuery } from "../router";
import { explainError } from "../format";
import type { ApiKey, CreateSecretResult, SendEvent, SmtpCredential } from "../types";

interface Snapshot {
  profile: SelfProfile;
  senders: SelfSender[];
  credentials: SmtpCredential[];
  apiKeys: ApiKey[];
  events: SendEvent[];
}

export async function renderMe(root: HTMLElement) {
  setChildren(
    root,
    skeletonHeader(),
    h("div", { id: "me-body" }, h("div", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "skeleton" })))),
  );

  let snapshot: Snapshot;
  try {
    const [profile, senders, credentials, apiKeys, events] = await Promise.all([
      selfApi.profile(),
      selfApi.senders(),
      selfApi.smtpCredentials(),
      selfApi.apiKeys(),
      selfApi.sendEvents().catch(() => []),
    ]);
    snapshot = { profile, senders, credentials, apiKeys, events };
  } catch (error) {
    paintError(root, error);
    return;
  }

  paint(root, snapshot);
}

function skeletonHeader(): HTMLElement {
  return h(
    "header",
    { class: "page-head" },
    h(
      "div",
      null,
      h("div", { class: "crumbs" }, h("span", null, "—"), h("span", { class: "sep" }, "/"), h("span", null, "me")),
      h("h1", null, "Your account"),
    ),
  );
}

function paintError(root: HTMLElement, error: unknown) {
  const message = error instanceof Error ? error.message : "Could not load your profile.";
  setChildren(
    root,
    skeletonHeader(),
    h("div", { class: "banner bad" }, icon("warn", 14), message),
  );
}

function paint(root: HTMLElement, s: Snapshot) {
  setChildren(
    root,
    header(s.profile),
    h(
      "div",
      { class: "spread" },
      profileCard(s.profile),
      sendersCard(s.senders),
      credentialsCard(root, s.credentials),
      apiKeysCard(root, s.apiKeys),
      activityCard(s.events),
    ),
  );
}

function header(profile: SelfProfile): HTMLElement {
  return h(
    "header",
    { class: "page-head" },
    h(
      "div",
      null,
      h("div", { class: "crumbs" }, h("span", null, "—"), h("span", { class: "sep" }, "/"), h("span", null, "me")),
      h(
        "div",
        { class: "row", style: "gap: 12px; align-items: center; margin-top: 4px" },
        h(
          "span",
          { class: "avatar", style: "width: 38px; height: 38px; border-radius: 99px; background: var(--accent-soft-strong); color: var(--accent-ink-on-soft); display: grid; place-items: center; font-size: 14px; font-weight: 600;" },
          initialsFor(profile.email),
        ),
        h(
          "div",
          null,
          h("h1", null, profile.display_name ?? profile.email),
          profile.display_name ? h("span", { class: "soft", style: "font-size: 13px" }, profile.email) : false,
        ) as Child,
      ),
    ),
    h("div", { class: "actions" }, pill(profile.role, profile.role === "admin" ? "info" : "muted")),
  );
}

function profileCard(profile: SelfProfile): HTMLElement {
  return h(
    "div",
    { class: "card" },
    h("div", { class: "card-head" }, h("h2", null, "Profile")),
    h(
      "div",
      { class: "card-body" },
      h(
        "dl",
        { class: "dl" },
        h("dt", null, "Email"), h("dd", null, copyable({ value: profile.email })),
        h("dt", null, "Display name"), h("dd", null, profile.display_name ?? h("span", { class: "soft" }, "—")),
        h("dt", null, "Role"), h("dd", null, pill(profile.role, profile.role === "admin" ? "info" : "muted")),
        h("dt", null, "Signed in via"), h("dd", null, h("span", { class: "mono", style: "font-size: 12.5px" }, "Cloudflare Access")),
        h("dt", null, "User ID"), h("dd", null, copyable({ value: profile.id })),
        h("dt", null, "Member since"), h("dd", { class: "soft" }, formatAbsolute(profile.created_at)),
      ),
    ),
  );
}

function sendersCard(senders: SelfSender[]): HTMLElement {
  const head = h(
    "div",
    { class: "card-head" },
    h(
      "h2",
      null,
      "Allowed senders",
      h("span", { class: "soft", style: "margin-left: 10px; font-weight: 400; font-size: 13px" }, `· ${senders.length}`),
    ),
    h("span", { class: "soft", style: "font-size: 12px" }, "Read-only · managed by admins"),
  );

  if (senders.length === 0) {
    return h(
      "div",
      { class: "card pad-0" },
      head,
      h(
        "div",
        { class: "empty" },
        h("div", { class: "empty-title" }, "No senders granted yet"),
        h(
          "div",
          { class: "empty-sub" },
          "You can't send mail until an admin grants you at least one sender address. Ask your relay admin to add you.",
        ),
      ),
    );
  }

  const list = h("div", { class: "stack", style: "gap: 0" });
  for (const sender of senders) {
    list.appendChild(
      h(
        "div",
        { class: "row-between", style: "padding: 12px 16px; border-bottom: 1px solid var(--border)" },
        h(
          "div",
          { class: "row", style: "gap: 10px; min-width: 0" },
          icon("user", 13),
          h("span", { class: "id", style: "color: var(--text); font-size: 13.5px" }, sender.email),
          h("span", { class: "soft", style: "font-size: 12px" }, "·"),
          h("span", { class: "soft", style: "font-size: 12px" }, sender.domain),
        ),
        sender.enabled ? pill("enabled", "ok") : pill("disabled", "muted"),
      ),
    );
  }
  return h("div", { class: "card pad-0" }, head, list);
}

function credentialsCard(root: HTMLElement, credentials: SmtpCredential[]): HTMLElement {
  const head = h(
    "div",
    { class: "card-head" },
    h(
      "h2",
      null,
      "SMTP credentials",
      h("span", { class: "soft", style: "margin-left: 10px; font-weight: 400; font-size: 13px" }, `· ${credentials.length}`),
    ),
    h(
      "button",
      { type: "button", class: "btn primary sm", "on:click": () => openCreateCredential(root) },
      icon("plus", 12),
      "New credential",
    ),
  );

  if (credentials.length === 0) {
    return h(
      "div",
      { class: "card pad-0" },
      head,
      h(
        "div",
        { class: "empty" },
        h("div", { class: "empty-title" }, "No SMTP credentials yet"),
        h(
          "div",
          { class: "empty-sub" },
          "Create your first credential and paste it into Gmail's \"Send mail as\" form.",
        ),
        h(
          "div",
          { class: "empty-actions" },
          h(
            "button",
            { type: "button", class: "btn primary", "on:click": () => openCreateCredential(root) },
            icon("plus", 12),
            "Create credential",
          ),
        ),
      ),
    );
  }

  const list = h("div", { class: "stack", style: "gap: 0" });
  for (const credential of credentials) {
    list.appendChild(credentialRow(root, credential));
  }
  return h("div", { class: "card pad-0" }, head, list);
}

function credentialRow(root: HTMLElement, credential: SmtpCredential): HTMLElement {
  return h(
    "div",
    { class: "row-between", style: "padding: 12px 16px; border-bottom: 1px solid var(--border); gap: 12px" },
    h(
      "div",
      { class: "stack", style: "gap: 3px; min-width: 0" },
      h(
        "div",
        { class: "row", style: "gap: 10px; min-width: 0" },
        h("span", { style: "font-weight: 500" }, credential.name),
        credential.revoked_at ? pill("revoked", "muted") : pill("active", "ok"),
      ),
      h(
        "div",
        { class: "row", style: "gap: 10px; font-size: 12px" },
        h("span", { class: "soft" }, "Username:"),
        copyable({ value: credential.username, display: credential.username }),
        credential.last_used_at
          ? h("span", { class: "soft" }, `· last used ${formatRelative(credential.last_used_at)}`)
          : h("span", { class: "soft" }, "· never used"),
      ),
    ) as Child,
    credential.revoked_at
      ? h("span", { class: "soft", style: "font-size: 12px" }, formatAbsolute(credential.revoked_at))
      : h(
          "button",
          {
            type: "button",
            class: "btn ghost sm danger",
            "on:click": async () => {
              if (!confirm(`Revoke ${credential.username}? This is immediate and cannot be undone.`)) return;
              try {
                await selfApi.revokeSmtpCredential(credential.id);
                toast(`${credential.username} revoked`);
                await renderMe(root);
              } catch (error) {
                const message = error instanceof ApiError ? error.message : "Could not revoke";
                toast(message, "err");
              }
            },
          },
          "Revoke",
        ),
  );
}

function apiKeysCard(root: HTMLElement, keys: ApiKey[]): HTMLElement {
  const head = h(
    "div",
    { class: "card-head" },
    h(
      "h2",
      null,
      "API keys",
      h("span", { class: "soft", style: "margin-left: 10px; font-weight: 400; font-size: 13px" }, `· ${keys.length}`),
    ),
    h(
      "button",
      { type: "button", class: "btn primary sm", "on:click": () => openCreateApiKey(root) },
      icon("plus", 12),
      "New API key",
    ),
  );

  if (keys.length === 0) {
    return h(
      "div",
      { class: "card pad-0" },
      head,
      h(
        "div",
        { class: "empty" },
        h("div", { class: "empty-title" }, "No API keys yet"),
        h(
          "div",
          { class: "empty-sub" },
          "For programmatic access to the HTTP /send endpoint.",
        ),
        h(
          "div",
          { class: "empty-actions" },
          h(
            "button",
            { type: "button", class: "btn primary", "on:click": () => openCreateApiKey(root) },
            icon("plus", 12),
            "Create API key",
          ),
        ),
      ),
    );
  }

  const list = h("div", { class: "stack", style: "gap: 0" });
  for (const key of keys) {
    list.appendChild(apiKeyRow(root, key));
  }
  return h("div", { class: "card pad-0" }, head, list);
}

function apiKeyRow(root: HTMLElement, key: ApiKey): HTMLElement {
  return h(
    "div",
    { class: "row-between", style: "padding: 12px 16px; border-bottom: 1px solid var(--border); gap: 12px" },
    h(
      "div",
      { class: "stack", style: "gap: 3px; min-width: 0" },
      h(
        "div",
        { class: "row", style: "gap: 10px; min-width: 0" },
        h("span", { style: "font-weight: 500" }, key.name),
        key.revoked_at ? pill("revoked", "muted") : pill("active", "ok"),
      ),
      h(
        "div",
        { class: "row", style: "gap: 10px; font-size: 12px" },
        h("span", { class: "soft" }, "Prefix:"),
        copyable({ value: key.key_prefix, display: key.key_prefix }),
        key.last_used_at
          ? h("span", { class: "soft" }, `· last used ${formatRelative(key.last_used_at)}`)
          : h("span", { class: "soft" }, "· never used"),
      ),
    ) as Child,
    key.revoked_at
      ? h("span", { class: "soft", style: "font-size: 12px" }, formatAbsolute(key.revoked_at))
      : h(
          "button",
          {
            type: "button",
            class: "btn ghost sm danger",
            "on:click": async () => {
              if (!confirm(`Revoke ${key.name}? This is immediate and cannot be undone.`)) return;
              try {
                await selfApi.revokeApiKey(key.id);
                toast(`${key.name} revoked`);
                await renderMe(root);
              } catch (error) {
                const message = error instanceof ApiError ? error.message : "Could not revoke";
                toast(message, "err");
              }
            },
          },
          "Revoke",
        ),
  );
}

function activityCard(events: SendEvent[]): HTMLElement {
  const head = h(
    "div",
    { class: "card-head" },
    h(
      "h2",
      null,
      "Recent activity",
      h("span", { class: "soft", style: "margin-left: 10px; font-weight: 400; font-size: 13px" }, `· ${events.length}`),
    ),
    h("span", { class: "soft", style: "font-size: 12px" }, "Your sends only · last 200"),
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
        h("div", { class: "empty-sub" }, "Once a message is sent using one of your credentials or API keys, it'll appear here."),
      ),
    );
  }

  const list = h("div", { class: "stack", style: "gap: 0" });
  for (const event of events.slice(0, 50)) {
    list.appendChild(activityRow(event));
  }
  return h("div", { class: "card pad-0" }, head, list);
}

function activityRow(event: SendEvent): HTMLElement {
  return h(
    "button",
    {
      type: "button",
      class: "row-between",
      style: "padding: 11px 16px; border-bottom: 1px solid var(--border); gap: 12px; background: transparent; width: 100%; text-align: left; cursor: pointer",
      "on:click": () => openEventDrawer(event),
    },
    h(
      "div",
      { class: "row", style: "gap: 12px; min-width: 0" },
      eventStatusPill(event.status),
      h("span", { class: "id" }, event.envelope_from),
      h("span", { class: "soft", style: "font-size: 12px" }, `→ ${event.recipient_count} ${event.recipient_count === 1 ? "recipient" : "recipients"}`),
    ),
    h(
      "div",
      { class: "row", style: "gap: 10px; font-size: 12px" },
      h("span", { class: "soft mono num" }, formatShort(event.ts)),
      h("span", { class: "soft mono" }, truncateMiddle(event.id, 6, 4)),
    ),
  );
}

function openEventDrawer(event: SendEvent) {
  const body = h("div", { class: "stack", style: "gap: 16px" });

  body.appendChild(
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
    body.appendChild(
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

  const dl = h("dl", { class: "dl" });
  dlRow(dl, "From", h("span", { class: "id" }, event.envelope_from));
  dlRow(dl, "Recipients", h("span", { class: "num" }, String(event.recipient_count)));
  dlRow(dl, "MIME size", h("span", { class: "mono num" }, formatBytes(event.mime_size_bytes)));
  dlRow(dl, "Source", h("span", { class: "uppercase mono" }, event.source));
  if (event.smtp_code) dlRow(dl, "SMTP code", h("span", { class: "mono num" }, event.smtp_code));
  if (event.credential_id) dlRow(dl, "Credential", copyable({ value: event.credential_id }));
  if (event.api_key_id) dlRow(dl, "API key", copyable({ value: event.api_key_id }));
  if (event.cf_request_id) dlRow(dl, "CF request ID", copyable({ value: event.cf_request_id }));
  if (event.cf_ray_id) dlRow(dl, "CF Ray", copyable({ value: event.cf_ray_id }));
  dlRow(dl, "Event ID", copyable({ value: event.id }));
  body.appendChild(dl);

  const footer = h(
    "div",
    { class: "row-between flex-fill" },
    h("span", { class: "soft", style: "font-size: 12px" }, `Event ${truncateMiddle(event.id, 6, 4)}`),
    h(
      "div",
      { class: "row" },
      h(
        "button",
        { type: "button", class: "btn ghost sm", "on:click": () => copy(JSON.stringify(event, null, 2), "Event JSON copied") },
        icon("copy", 12),
        "Copy JSON",
      ),
      h("button", { type: "button", class: "btn sm", "on:click": () => { closeDrawer(); replaceQuery({ id: undefined }); } }, "Close"),
    ),
  );

  openDrawer({
    title: "Send event",
    crumbs: [h("span", null, "me"), h("span", { class: "sep" }, "/"), h("span", null, truncateMiddle(event.id, 8, 4))],
    body,
    footer,
    onClose: () => replaceQuery({ id: undefined }),
  });
}

function dlRow(dl: HTMLElement, label: string, value: Child) {
  dl.appendChild(h("dt", null, label));
  dl.appendChild(h("dd", null, value));
}

// ───────────────────────── Create flows ─────────────────────────

export function openCreateCredential(root: HTMLElement) {
  const { form, setError, setBanner, busy } = buildForm(
    [
      { name: "name", label: "Label", required: true, placeholder: "Gmail · laptop", hint: "For your reference — not sent over the wire." },
      { name: "username", label: "SMTP username", required: true, placeholder: "gmail-relay", hint: "Paste this into Gmail as the SMTP username. Must be globally unique." },
    ],
    async (raw) => {
      setError("name", null);
      setError("username", null);
      setBanner(null);
      if (!raw.name) setError("name", "Required");
      if (!raw.username) setError("username", "Required");
      if (!raw.name || !raw.username) return;
      busy(true);
      try {
        const result = await selfApi.createSmtpCredential({ name: raw.name, username: raw.username });
        toast("Credential created");
        revealCredential(result, () => {
          closeModal();
          void renderMe(root);
        });
      } catch (error) {
        const message = error instanceof ApiError ? error.message : "Could not create credential.";
        setBanner(message);
        busy(false);
      }
    },
  );

  const submit = h("button", { type: "submit", class: "btn primary" }, "Create credential");
  const cancel = h("button", { type: "button", class: "btn ghost", "on:click": () => closeModal() }, "Cancel");
  submit.addEventListener("click", () => form.requestSubmit());

  openModal({
    title: "New SMTP credential",
    body: form,
    footer: h("div", { class: "row-between flex-fill" }, cancel, submit),
  });
}

export function openCreateApiKey(root: HTMLElement) {
  const { form, setError, setBanner, busy } = buildForm(
    [
      { name: "name", label: "Label", required: true, placeholder: "billing-app prod", hint: "For your reference." },
    ],
    async (raw) => {
      setError("name", null);
      setBanner(null);
      if (!raw.name) {
        setError("name", "Required");
        return;
      }
      busy(true);
      try {
        const result = await selfApi.createApiKey({ name: raw.name });
        toast("API key created");
        revealApiKey(result, () => {
          closeModal();
          void renderMe(root);
        });
      } catch (error) {
        const message = error instanceof ApiError ? error.message : "Could not create API key.";
        setBanner(message);
        busy(false);
      }
    },
  );

  const submit = h("button", { type: "submit", class: "btn primary" }, "Create key");
  const cancel = h("button", { type: "button", class: "btn ghost", "on:click": () => closeModal() }, "Cancel");
  submit.addEventListener("click", () => form.requestSubmit());

  openModal({
    title: "New API key",
    body: form,
    footer: h("div", { class: "row-between flex-fill" }, cancel, submit),
  });
}

function revealCredential(result: CreateSecretResult, onDone: () => void) {
  openModal({
    title: "Credential created",
    body: secretRevealBody({
      title: "SMTP credential",
      meta: [{ label: "Username", value: result.username ?? "", mono: true }],
      secret: result.secret,
      warning: "Paste this into Gmail's \"Send mail as\" form now. We cannot show it again.",
    }),
    footer: h(
      "div",
      { class: "row-between flex-fill" },
      h("span", { class: "soft", style: "font-size: 12px" }, "Stored as HMAC-SHA256(pepper, secret)"),
      h(
        "button",
        { type: "button", class: "btn primary", "on:click": () => { closeModal(); onDone(); } },
        icon("check", 13),
        "I've saved it",
      ),
    ),
  });
}

function revealApiKey(result: CreateSecretResult, onDone: () => void) {
  openModal({
    title: "API key created",
    body: secretRevealBody({
      title: "API key",
      meta: [{ label: "Prefix", value: result.key_prefix ?? "", mono: true }],
      secret: result.secret,
      warning: "Use this as the bearer token: Authorization: Bearer <secret>. It will not be shown again.",
    }),
    footer: h(
      "div",
      { class: "row-between flex-fill" },
      h("span", { class: "soft", style: "font-size: 12px" }, "Stored as HMAC-SHA256(pepper, secret)"),
      h(
        "button",
        { type: "button", class: "btn primary", "on:click": () => { closeModal(); onDone(); } },
        icon("check", 13),
        "I've saved it",
      ),
    ),
  });
}
