import { api, ApiError } from "../api";
import type { Child } from "../dom";
import { h, icon, setChildren } from "../dom";
import { copyable } from "../clipboard";
import { formatRelative, initialsFor } from "../format";
import { buildForm, closeModal, openModal, secretRevealBody } from "../modal";
import { pill } from "../status";
import { buildTable } from "../table";
import { navigate, parse, replaceQuery } from "../router";
import { toast } from "../toast";
import type { CreateSecretResult, Sender, SmtpCredential, User } from "../types";

export async function renderCredentials(root: HTMLElement) {
  setChildren(
    root,
    head(),
    h("div", { id: "credentials-table" }, h("div", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "skeleton" })))),
  );

  let credentials: SmtpCredential[] = [];
  let users: User[] = [];
  let senders: Sender[] = [];
  try {
    [credentials, users, senders] = await Promise.all([
      api.listSmtpCredentials(),
      api.listUsers(),
      api.listSenders(),
    ]);
  } catch (error) {
    const target = root.querySelector<HTMLElement>("#credentials-table");
    if (target) {
      const message = error instanceof Error ? error.message : "Could not load credentials.";
      setChildren(target, h("div", { class: "banner bad" }, icon("warn", 14), message));
    }
    return;
  }
  paint(root, credentials, users, senders);

  const query = parse().query;
  if (query.get("new") === "1") {
    replaceQuery({ new: undefined });
    openNewCredential(users, senders, () => renderCredentials(root), { userId: query.get("user") });
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
      h("h1", null, "SMTP credentials"),
      h(
        "div",
        { class: "soft", style: "margin-top: 6px; font-size: 13px; max-width: 64ch" },
        "Each credential belongs to one user and inherits that user's allowed senders. Paste the username + secret into Gmail's \"Send mail as\" form.",
      ),
    ),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          type: "button",
          class: "btn primary",
          "on:click": async () => {
            const [users, senders] = await Promise.all([api.listUsers(), api.listSenders()]);
            openNewCredential(users, senders, () => navigate("/credentials"));
          },
        },
        icon("plus", 13),
        "New credential",
      ),
    ),
  );
}

function paint(root: HTMLElement, credentials: SmtpCredential[], users: User[], senders: Sender[]) {
  const target = root.querySelector<HTMLElement>("#credentials-table");
  if (!target) return;
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
                      await renderCredentials(root);
                    } catch (error) {
                      const message = error instanceof ApiError ? error.message : "Could not revoke";
                      toast(message, "err");
                    }
                  },
                },
                "Revoke",
              ),
        width: 100,
      },
    ],
    rows: credentials,
    defaultSort: { key: "last", dir: "desc" },
    search: (row) => `${row.name} ${row.username} ${row.user_email} ${row.id}`,
    searchPlaceholder: "Search credentials…",
    emptyTitle: "No SMTP credentials",
    emptyHint: "Create the first credential for a user; this is the password Gmail \"Send mail as\" will store.",
    emptyAction: h(
      "button",
      {
        type: "button",
        class: "btn primary",
        "on:click": () => openNewCredential(users, senders, () => renderCredentials(root)),
      },
      icon("plus", 12),
      "New credential",
    ) as Child,
  });
  setChildren(target, built.root);
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
        placeholder: "Gmail · laptop",
        hint: "Just for your reference — never sent over the wire.",
      },
      {
        name: "username",
        label: "Username",
        required: true,
        placeholder: "gmail-relay",
        hint: "Paste this into Gmail as the SMTP username.",
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
        const message = error instanceof ApiError ? error.message : "Could not create credential.";
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

export function revealCredential(result: CreateSecretResult, onDone: () => void) {
  const body = secretRevealBody({
    title: "SMTP credential",
    meta: [
      { label: "Username", value: result.username ?? "", mono: true },
    ],
    secret: result.secret,
    warning: "Paste this into Gmail's \"Send mail as\" form now. We cannot show it again.",
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
