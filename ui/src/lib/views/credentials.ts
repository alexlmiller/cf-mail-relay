import { api, describeError } from "../api";
import type { Child } from "../dom";
import { h, icon, setChildren } from "../dom";
import { copyable } from "../clipboard";
import { formatRelative, initialsFor } from "../format";
import { buildForm, closeModal, openModal, secretRevealBody } from "../modal";
import { pill } from "../status";
import { buildTable } from "../table";
import { navigate, parse, replaceQuery } from "../router";
import { toast } from "../toast";
import { smtpSecretMeta, smtpSecretWarning } from "../smtp";
import { buildApiKeysCard, openNewApiKey } from "./api-keys";
import type { ApiKey, CreateSecretResult, Sender, SmtpCredential, User } from "../types";

interface CredentialsPageData {
  credentials: SmtpCredential[];
  apiKeys: ApiKey[];
  users: User[];
  senders: Sender[];
}

export async function renderCredentials(root: HTMLElement) {
  setChildren(
    root,
    head(),
    h(
      "div",
      { id: "credentials-body", class: "stack", style: "gap: 24px" },
      h("div", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "skeleton" }))),
      h("div", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "skeleton" }))),
    ),
  );

  let data: CredentialsPageData;
  try {
    const [credentials, apiKeys, users, senders] = await Promise.all([
      api.listSmtpCredentials(),
      api.listApiKeys(),
      api.listUsers(),
      api.listSenders(),
    ]);
    data = { credentials, apiKeys, users, senders };
  } catch (error) {
    const target = root.querySelector<HTMLElement>("#credentials-body");
    if (target) {
      const message = error instanceof Error ? error.message : "Could not load credentials.";
      setChildren(target, h("div", { class: "banner bad" }, icon("warn", 14), message));
    }
    return;
  }

  paint(root, data);

  // Honor deep-link query params: ?new=smtp opens the SMTP modal; ?new=api
  // opens the API-key modal; legacy ?new=1 defaults to SMTP.
  const query = parse().query;
  const newParam = query.get("new");
  if (newParam === "smtp" || newParam === "1") {
    replaceQuery({ new: undefined });
    openNewCredential(data.users, data.senders, () => renderCredentials(root), { userId: query.get("user") });
  } else if (newParam === "api") {
    replaceQuery({ new: undefined });
    openNewApiKey(data.users, data.senders, () => renderCredentials(root), { userId: query.get("user") });
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
        h("span", null, "credentials"),
      ),
      h("h1", null, "Credentials"),
      h(
        "div",
        { class: "soft", style: "margin-top: 6px; font-size: 13px; max-width: 64ch" },
        "Secrets your users authenticate with — SMTP passwords for mail clients, bearer tokens for the HTTP API. Both inherit the owning user's allowed senders.",
      ),
    ),
    h("div", { class: "actions" }),
  );
}

function paint(root: HTMLElement, data: CredentialsPageData) {
  const target = root.querySelector<HTMLElement>("#credentials-body");
  if (!target) return;
  const onReload = () => renderCredentials(root);
  setChildren(
    target,
    buildSmtpCredentialsCard(data, onReload),
    buildApiKeysCard({ keys: data.apiKeys, users: data.users, senders: data.senders }, onReload),
  );
}

export interface SmtpCredentialsCardData {
  credentials: SmtpCredential[];
  users: User[];
  senders: Sender[];
}

/**
 * Renders the SMTP credentials section as a labelled card. Composed by the
 * combined Credentials page alongside the API keys card.
 */
export function buildSmtpCredentialsCard(
  data: SmtpCredentialsCardData,
  onReload: () => Promise<void> | void,
): HTMLElement {
  const { credentials, users, senders } = data;
  const built = buildTable<SmtpCredential>({
    columns: [
      {
        key: "name",
        label: "Name",
        render: (row) => h("span", { style: "font-weight: 500" }, row.name),
        sort: (row) => row.name,
      },
      {
        key: "username",
        label: "Username",
        render: (row) => copyable({ value: row.username, display: row.username, withIcon: true }),
        sort: (row) => row.username,
        width: 200,
      },
      {
        key: "user",
        label: "Owner",
        render: (row) =>
          h(
            "a",
            { href: `#/users/${row.user_id}`, class: "row", style: "gap: 8px" },
            avatar(row.user_email),
            h("span", { class: "soft" }, row.user_email),
          ),
        sort: (row) => row.user_email,
        width: 240,
      },
      {
        key: "scope",
        label: "Scope",
        render: (row) =>
          row.allowed_sender_ids_json
            ? pill("restricted", "warn", "Credential restricted to a subset of the user's senders")
            : pill("inherits user", "muted"),
        width: 150,
      },
      {
        key: "last",
        label: "Last used",
        render: (row) =>
          row.last_used_at
            ? h("span", { class: "soft" }, formatRelative(row.last_used_at))
            : h("span", { class: "soft" }, "never"),
        sort: (row) => row.last_used_at ?? 0,
        width: 140,
      },
      {
        key: "state",
        label: "State",
        render: (row) => (row.revoked_at ? pill("revoked", "muted") : pill("active", "ok")),
        sort: (row) => (row.revoked_at ? 1 : 0),
        width: 100,
      },
      {
        key: "actions",
        label: "",
        render: (row) =>
          row.revoked_at
            ? h("span", { class: "soft" }, "—")
            : h(
                "div",
                { class: "row", style: "gap: 4px; justify-content: flex-end" },
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn ghost sm",
                    title: "Rename this credential",
                    "on:click": (event: Event) => {
                      event.stopPropagation();
                      openRenameCredential(row, () => onReload());
                    },
                  },
                  "Edit",
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn ghost sm",
                    title: "Generate a new secret on this same credential",
                    "on:click": async (event: Event) => {
                      event.stopPropagation();
                      if (!confirm(`Roll ${row.username}? The old password will stop working immediately; the new one needs to be pasted into Gmail.`)) return;
                      try {
                        const result = await api.rollSmtpCredential(row.id);
                        revealCredential(result, () => onReload());
                      } catch (error) {
                        toast(describeError(error, "Could not roll"), "err");
                      }
                    },
                  },
                  "Roll",
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn ghost sm danger",
                    "on:click": async (event: Event) => {
                      event.stopPropagation();
                      if (!confirm(`Revoke ${row.username}? This is immediate and cannot be undone.`)) return;
                      try {
                        await api.revokeSmtpCredential(row.id);
                        toast(`${row.username} revoked`);
                        await onReload();
                      } catch (error) {
                        toast(describeError(error, "Could not revoke"), "err");
                      }
                    },
                  },
                  "Revoke",
                ),
              ),
        width: 200,
      },
    ],
    rows: credentials,
    defaultSort: { key: "last", dir: "desc" },
    search: (row) => `${row.name} ${row.username} ${row.user_email} ${row.id}`,
    searchPlaceholder: "Search credentials…",
    emptyTitle: "No SMTP credentials",
    emptyHint: "Create the first SMTP credential for a user or application.",
    cardMode: true,
    emptyAction: h(
      "button",
      {
        type: "button",
        class: "btn primary",
        "on:click": () => openNewCredential(users, senders, () => onReload()),
      },
      icon("plus", 12),
      "New SMTP credential",
    ) as Child,
  });
  return h(
    "section",
    { class: "section" },
    h(
      "div",
      { class: "section-head" },
      h(
        "h2",
        null,
        "SMTP credentials",
        h("span", { class: "soft", style: "margin-left: 8px; font-weight: 400; font-size: 13px" }, `· ${credentials.length}`),
      ),
      h(
        "button",
        {
          type: "button",
          class: "btn primary sm",
          "on:click": () => openNewCredential(users, senders, () => onReload()),
        },
        icon("plus", 12),
        "New SMTP credential",
      ),
    ),
    h(
      "div",
      { class: "soft", style: "font-size: 12.5px; max-width: 64ch" },
      "Username + password for any SMTP client (Gmail, Postfix, Rails, etc.). Inherits the owning user's allowed senders.",
    ),
    built.root,
  );
}

function avatar(email: string): HTMLElement {
  return h(
    "span",
    { class: "avatar", style: "width: 22px; height: 22px; border-radius: 99px; background: var(--accent-soft-strong); color: var(--accent-ink-on-soft); display: grid; place-items: center; font-size: 10.5px; font-weight: 600;" },
    initialsFor(email),
  );
}

export interface NewCredentialOptions {
  userId?: string | null;
}

export function openNewCredential(users: User[], senders: Sender[], onCreated: (id: string) => void, options: NewCredentialOptions = {}) {
  if (users.length === 0) {
    openModal({
      title: "New SMTP credential",
      body: h(
        "div",
        { class: "banner warn" },
        icon("warn", 14),
        "Add a user first — credentials must belong to a user.",
      ),
      footer: h(
        "div",
        { class: "row-between flex-fill" },
        h("button", { type: "button", class: "btn ghost", "on:click": () => closeModal() }, "Cancel"),
        h("button", { type: "button", class: "btn primary", "on:click": () => { closeModal(); navigate("/users", { new: "1" }); } }, "Add user"),
      ),
    });
    return;
  }

  const sendersByUser = new Map<string, Sender[]>();
  for (const sender of senders) {
    if (!sender.user_id) continue;
    const list = sendersByUser.get(sender.user_id) ?? [];
    list.push(sender);
    sendersByUser.set(sender.user_id, list);
  }

  const initialUserId = options.userId ?? users[0]?.id ?? "";

  const { form, setError, setBanner, busy } = buildForm(
    [
      {
        name: "user_id",
        label: "Owner",
        kind: "select",
        value: initialUserId,
        options: users.map((u) => ({ value: u.id, label: u.email })),
        hint: "Credentials inherit allowed senders from this user.",
      },
      {
        name: "name",
        label: "Label",
        required: true,
        placeholder: "Laptop mail client",
        hint: "Just for your reference — never sent over the wire.",
      },
      {
        name: "username",
        label: "Username",
        required: true,
        placeholder: "smtp-relay",
        hint: "Use this as the SMTP username.",
      },
    ],
    async (raw) => {
      setError("name", null);
      setError("username", null);
      setBanner(null);
      if (!raw.name || !raw.username) {
        if (!raw.name) setError("name", "Required");
        if (!raw.username) setError("username", "Required");
        return;
      }
      busy(true);
      try {
        const result = await api.createSmtpCredential({
          user_id: raw.user_id,
          name: raw.name,
          username: raw.username,
        });
        toast("Credential created");
        revealCredential(result, () => {
          closeModal();
          onCreated(result.id);
        });
      } catch (error) {
        const message = describeError(error, "Could not create credential.");
        setBanner(message);
        busy(false);
      }
    },
  );

  // Granted-senders preview — re-renders on user change.
  const preview = h("div", { class: "stack", style: "gap: 6px" });
  function renderPreview(userId: string) {
    const list = sendersByUser.get(userId) ?? [];
    setChildren(
      preview,
      h("div", { class: "uppercase soft" }, "This credential will be allowed to send as"),
      list.length === 0
        ? h(
            "div",
            { class: "banner warn" },
            icon("warn", 14),
            "This user has no allowed senders yet. Without senders the credential cannot send any mail. ",
            h(
              "a",
              {
                class: "link",
                href: "#/senders?new=1",
                "on:click": () => closeModal(),
              },
              "Grant sender →",
            ),
          )
        : h("div", { class: "row", style: "flex-wrap: wrap; gap: 6px" }, ...list.map((s) => h("span", { class: "pill-static mono" }, s.email))),
    );
  }
  renderPreview(initialUserId);

  const userSelect = form.elements.namedItem("user_id");
  if (userSelect instanceof HTMLSelectElement) {
    userSelect.addEventListener("change", () => renderPreview(userSelect.value));
  }

  form.appendChild(preview);

  const submit = h("button", { type: "submit", class: "btn primary" }, "Create credential");
  const cancel = h("button", { type: "button", class: "btn ghost", "on:click": () => closeModal() }, "Cancel");
  submit.addEventListener("click", () => form.requestSubmit());

  openModal({
    title: "New SMTP credential",
    body: form,
    footer: h("div", { class: "row-between flex-fill" }, cancel, submit),
  });
}

export function openRenameCredential(credential: SmtpCredential, onSaved: () => void) {
  const { form, setBanner, busy } = buildForm(
    [
      {
        name: "name",
        label: "Label",
        required: true,
        value: credential.name,
        hint: "For your reference — never sent over the wire.",
      },
    ],
    async (raw) => {
      setBanner(null);
      busy(true);
      try {
        await api.updateSmtpCredential(credential.id, { name: raw.name });
        toast("Credential renamed");
        closeModal();
        onSaved();
      } catch (error) {
        setBanner(describeError(error, "Could not rename credential."));
        busy(false);
      }
    },
  );
  const submit = h("button", { type: "submit", class: "btn primary" }, "Save");
  const cancel = h("button", { type: "button", class: "btn ghost", "on:click": () => closeModal() }, "Cancel");
  submit.addEventListener("click", () => form.requestSubmit());
  openModal({
    title: `Edit ${credential.username}`,
    body: form,
    footer: h("div", { class: "row-between flex-fill" }, cancel, submit),
  });
}

export function revealCredential(result: CreateSecretResult, onDone: () => void) {
  const body = secretRevealBody({
    title: "SMTP credential",
    meta: smtpSecretMeta(result),
    secret: result.secret,
    warning: smtpSecretWarning(result),
  });
  openModal({
    title: "Credential created",
    body,
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
