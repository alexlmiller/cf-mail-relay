import { api, describeError } from "../api";
import type { Child } from "../dom";
import { h, icon, setChildren } from "../dom";
import { copyable } from "../clipboard";
import { close as closeDrawer, openDrawer } from "../drawer";
import { formatAbsolute, formatRelative, initialsFor } from "../format";
import { buildForm, closeModal, openModal, secretRevealBody } from "../modal";
import { pill } from "../status";
import { buildTable } from "../table";
import { navigate } from "../router";
import { toast } from "../toast";
import type { ApiKey, CreateSecretResult, Sender, User } from "../types";

export interface ApiKeysCardData {
  keys: ApiKey[];
  users: User[];
  senders: Sender[];
}

/**
 * Renders the API keys section as a labelled card. Composed by the
 * combined Credentials page (`views/credentials.ts`) alongside the SMTP
 * credentials card; not a top-level page on its own.
 */
export function buildApiKeysCard(data: ApiKeysCardData, onReload: () => Promise<void> | void): HTMLElement {
  const { keys, users, senders } = data;
  const built = buildTable<ApiKey>({
    columns: [
      {
        key: "name",
        label: "Name",
        primary: true,
        render: (row) => h(
          "span",
          { class: "row", style: "gap: 10px; flex-wrap: wrap; align-items: center" },
          h("span", { style: "font-weight: 500" }, row.name),
          row.revoked_at ? pill("revoked", "muted") : pill("active", "ok"),
        ),
        sort: (row) => row.name,
      },
      {
        key: "prefix",
        label: "Prefix",
        cell: "mono",
        render: (row) => copyable({ value: row.key_prefix, display: row.key_prefix }),
        sort: (row) => row.key_prefix,
        width: 130,
      },
      {
        key: "user",
        label: "Owner",
        render: (row) =>
          h(
            "a",
            { href: `#/users/${row.user_id}`, class: "row", style: "gap: 8px", "on:click": (event: Event) => event.stopPropagation() },
            h(
              "span",
              { class: "avatar", style: "width: 22px; height: 22px; border-radius: 99px; background: var(--accent-soft-strong); color: var(--accent-ink-on-soft); display: grid; place-items: center; font-size: 10.5px; font-weight: 600;" },
              initialsFor(row.user_email),
            ),
            h("span", { class: "soft" }, row.user_email),
          ),
        sort: (row) => row.user_email,
        width: 240,
      },
      {
        key: "scope",
        label: "Scope",
        hideOnCard: true,
        render: (row) =>
          row.allowed_sender_ids_json
            ? pill("restricted", "warn", "Key restricted to a subset of the user's senders")
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
        hideOnCard: true,
        render: (row) => (row.revoked_at ? pill("revoked", "muted") : pill("active", "ok")),
        sort: (row) => (row.revoked_at ? 1 : 0),
        width: 100,
      },
      {
        key: "actions",
        label: "",
        hideOnCard: true,
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
                    title: "Rename this API key",
                    "on:click": (event: Event) => {
                      event.stopPropagation();
                      openRenameApiKey(row, () => onReload());
                    },
                  },
                  "Edit",
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn ghost sm",
                    title: "Generate a new bearer token on this same key",
                    "on:click": async (event: Event) => {
                      event.stopPropagation();
                      if (!confirm(`Roll ${row.name}? The old token will stop working immediately; replace it in any application that uses it.`)) return;
                      try {
                        const result = await api.rollApiKey(row.id);
                        revealApiKey(result, () => onReload());
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
                      if (!confirm(`Revoke ${row.name}? This is immediate and cannot be undone.`)) return;
                      try {
                        await api.revokeApiKey(row.id);
                        toast(`${row.name} revoked`);
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
    rows: keys,
    defaultSort: { key: "last", dir: "desc" },
    search: (row) => `${row.name} ${row.key_prefix} ${row.user_email} ${row.id}`,
    searchPlaceholder: "Search API keys…",
    emptyTitle: "No API keys",
    emptyHint: "Create a key to call the HTTP /send endpoint from your applications.",
    cardMode: true,
    onRowClick: (row) => openApiKeyDrawer(row, () => onReload()),
    emptyAction: h(
      "button",
      {
        type: "button",
        class: "btn primary",
        "on:click": () => openNewApiKey(users, senders, () => onReload()),
      },
      icon("plus", 12),
      "New API key",
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
        "API keys",
        h("span", { class: "soft", style: "margin-left: 8px; font-weight: 400; font-size: 13px" }, `· ${keys.length}`),
      ),
      h(
        "button",
        {
          type: "button",
          class: "btn primary sm",
          "on:click": () => openNewApiKey(users, senders, () => onReload()),
        },
        icon("plus", 12),
        "New API key",
      ),
    ),
    h(
      "div",
      { class: "soft", style: "font-size: 12.5px; max-width: 64ch" },
      "Bearer tokens for the HTTP ",
      h("span", { class: "mono" }, "/send"),
      " endpoint. Like SMTP credentials, they inherit a user's allowed senders.",
    ),
    built.root,
  );
}

interface NewKeyOptions { userId?: string | null }

export function openNewApiKey(users: User[], senders: Sender[], onCreated: (id: string) => void, options: NewKeyOptions = {}) {
  if (users.length === 0) {
    openModal({
      title: "New API key",
      body: h(
        "div",
        { class: "banner warn" },
        icon("warn", 14),
        "Add a user first — keys must belong to a user.",
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
      },
      {
        name: "name",
        label: "Label",
        required: true,
        placeholder: "billing-app prod",
        hint: "Just for your reference.",
      },
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
        const result = await api.createApiKey({ user_id: raw.user_id, name: raw.name });
        toast("API key created");
        revealApiKey(result, () => {
          closeModal();
          onCreated(result.id);
        });
      } catch (error) {
        const message = describeError(error, "Could not create API key.");
        setBanner(message);
        busy(false);
      }
    },
  );

  const preview = h("div", { class: "stack", style: "gap: 6px" });
  function renderPreview(userId: string) {
    const list = sendersByUser.get(userId) ?? [];
    setChildren(
      preview,
      h("div", { class: "uppercase soft" }, "This API key will be allowed to send as"),
      list.length === 0
        ? h(
            "div",
            { class: "banner warn" },
            icon("warn", 14),
            "This user has no allowed senders yet. ",
            h("a", { class: "link", href: "#/senders?new=1", "on:click": () => closeModal() }, "Grant sender →"),
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

  const submit = h("button", { type: "submit", class: "btn primary" }, "Create key");
  const cancel = h("button", { type: "button", class: "btn ghost", "on:click": () => closeModal() }, "Cancel");
  submit.addEventListener("click", () => form.requestSubmit());

  openModal({
    title: "New API key",
    body: form,
    footer: h("div", { class: "row-between flex-fill" }, cancel, submit),
  });
}

export function openRenameApiKey(key: ApiKey, onSaved: () => void) {
  const { form, setBanner, busy } = buildForm(
    [
      {
        name: "name",
        label: "Label",
        required: true,
        value: key.name,
        hint: "For your reference.",
      },
    ],
    async (raw) => {
      setBanner(null);
      busy(true);
      try {
        await api.updateApiKey(key.id, { name: raw.name });
        toast("API key renamed");
        closeModal();
        onSaved();
      } catch (error) {
        setBanner(describeError(error, "Could not rename API key."));
        busy(false);
      }
    },
  );
  const submit = h("button", { type: "submit", class: "btn primary" }, "Save");
  const cancel = h("button", { type: "button", class: "btn ghost", "on:click": () => closeModal() }, "Cancel");
  submit.addEventListener("click", () => form.requestSubmit());
  openModal({
    title: `Edit ${key.name}`,
    body: form,
    footer: h("div", { class: "row-between flex-fill" }, cancel, submit),
  });
}

export function revealApiKey(result: CreateSecretResult, onDone: () => void) {
  const body = secretRevealBody({
    title: "API key",
    meta: [{ label: "Prefix", value: result.key_prefix ?? "", mono: true }],
    secret: result.secret,
    warning: "Use this as the bearer token: Authorization: Bearer <secret>. It will not be shown again.",
  });
  openModal({
    title: "API key created",
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

// ───────────────────────── Detail drawer ─────────────────────────

export function openApiKeyDrawer(
  key: ApiKey,
  onChanged: () => Promise<void> | void,
): void {
  const revoked = key.revoked_at !== null;
  const allowed = key.allowed_sender_ids_json
    ? (JSON.parse(key.allowed_sender_ids_json) as string[])
    : null;
  const avatar = h(
    "span",
    { class: "avatar", style: "width: 22px; height: 22px; border-radius: 99px; background: var(--accent-soft-strong); color: var(--accent-ink-on-soft); display: grid; place-items: center; font-size: 10.5px; font-weight: 600;" },
    initialsFor(key.user_email),
  );

  const body = h(
    "div",
    { class: "stack", style: "gap: 18px" },
    h(
      "dl",
      { class: "dl" },
      h("dt", null, "Name"), h("dd", null, h("span", { style: "font-weight: 500" }, key.name)),
      h("dt", null, "Prefix"), h("dd", null, copyable({ value: key.key_prefix, display: key.key_prefix })),
      h("dt", null, "Owner"),
      h(
        "dd",
        null,
        h(
          "a",
          { class: "row", style: "gap: 8px", href: `#/users/${key.user_id}`, "on:click": () => closeDrawer() },
          avatar,
          h("span", null, key.user_email),
        ),
      ),
      h("dt", null, "Scope"),
      h(
        "dd",
        null,
        allowed === null
          ? pill("inherits user", "muted")
          : pill(`restricted · ${allowed.length}`, "warn", "Key restricted to a subset of the user's senders"),
      ),
      h("dt", null, "Last used"), h("dd", { class: "soft" }, key.last_used_at ? formatAbsolute(key.last_used_at) : "never"),
      h("dt", null, "Created"), h("dd", { class: "soft" }, formatAbsolute(key.created_at)),
      revoked ? h("dt", null, "Revoked") : false,
      revoked ? h("dd", { class: "soft" }, formatAbsolute(key.revoked_at as number)) : false,
      h("dt", null, "State"),
      h("dd", null, revoked ? pill("revoked", "muted") : pill("active", "ok")),
      h("dt", null, "ID"), h("dd", null, copyable({ value: key.id, display: key.id })),
    ),
  );

  const footer = revoked
    ? h(
        "div",
        { class: "soft", style: "font-size: 13px" },
        "This API key is revoked and cannot be used.",
      )
    : h(
        "div",
        { class: "row", style: "gap: 8px; flex-wrap: wrap; width: 100%" },
        h(
          "button",
          {
            type: "button",
            class: "btn ghost",
            title: "Rename this API key",
            "on:click": () => openRenameApiKey(key, async () => {
              closeDrawer();
              await onChanged();
            }),
          },
          "Edit",
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn ghost",
            title: "Generate a new bearer token on this same key",
            "on:click": async () => {
              if (!confirm(`Roll ${key.name}? The old token will stop working immediately; replace it in any application that uses it.`)) return;
              try {
                const result = await api.rollApiKey(key.id);
                closeDrawer();
                revealApiKey(result, () => onChanged());
              } catch (error) {
                toast(describeError(error, "Could not roll"), "err");
              }
            },
          },
          "Roll token",
        ),
        h("span", { class: "flex-fill" }),
        h(
          "button",
          {
            type: "button",
            class: "btn danger",
            "on:click": async () => {
              if (!confirm(`Revoke ${key.name}? This is immediate and cannot be undone.`)) return;
              try {
                await api.revokeApiKey(key.id);
                toast(`${key.name} revoked`);
                closeDrawer();
                await onChanged();
              } catch (error) {
                toast(describeError(error, "Could not revoke"), "err");
              }
            },
          },
          "Revoke",
        ),
      );

  openDrawer({
    title: key.name,
    crumbs: [
      h("a", { href: "#/credentials", "on:click": () => closeDrawer() }, "credentials"),
      h("span", { class: "sep" }, "/"),
      h("span", null, "api"),
    ],
    body,
    footer,
  });
}
