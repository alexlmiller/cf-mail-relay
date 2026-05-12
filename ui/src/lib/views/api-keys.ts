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
import type { ApiKey, CreateSecretResult, Sender, User } from "../types";

export async function renderApiKeys(root: HTMLElement) {
  setChildren(
    root,
    head(),
    h("div", { id: "api-keys-table" }, h("div", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "skeleton" })))),
  );

  let keys: ApiKey[] = [];
  let users: User[] = [];
  let senders: Sender[] = [];
  try {
    [keys, users, senders] = await Promise.all([
      api.listApiKeys(),
      api.listUsers(),
      api.listSenders(),
    ]);
  } catch (error) {
    const target = root.querySelector<HTMLElement>("#api-keys-table");
    if (target) {
      const message = error instanceof Error ? error.message : "Could not load API keys.";
      setChildren(target, h("div", { class: "banner bad" }, icon("warn", 14), message));
    }
    return;
  }
  paint(root, keys, users, senders);

  const query = parse().query;
  if (query.get("new") === "1") {
    replaceQuery({ new: undefined });
    openNewApiKey(users, senders, () => renderApiKeys(root), { userId: query.get("user") });
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
        h("span", null, "api-keys"),
      ),
      h("h1", null, "API keys"),
      h(
        "div",
        { class: "soft", style: "margin-top: 6px; font-size: 13px; max-width: 64ch" },
        "Bearer tokens for the HTTP ",
        h("span", { class: "mono" }, "/send"),
        " endpoint. Like SMTP credentials, they inherit a user's allowed senders.",
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
            openNewApiKey(users, senders, () => navigate("/api-keys"));
          },
        },
        icon("plus", 13),
        "New API key",
      ),
    ),
  );
}

function paint(root: HTMLElement, keys: ApiKey[], users: User[], senders: Sender[]) {
  const target = root.querySelector<HTMLElement>("#api-keys-table");
  if (!target) return;
  const built = buildTable<ApiKey>({
    columns: [
      {
        key: "name",
        label: "Name",
        render: (row) => h("span", { style: "font-weight: 500" }, row.name),
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
            { href: `#/users/${row.user_id}`, class: "row", style: "gap: 8px" },
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
                    title: "Generate a new bearer token on this same key",
                    "on:click": async (event: Event) => {
                      event.stopPropagation();
                      if (!confirm(`Roll ${row.name}? The old token will stop working immediately; replace it in any application that uses it.`)) return;
                      try {
                        const result = await api.rollApiKey(row.id);
                        revealApiKey(result, () => renderApiKeys(root));
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
                        await renderApiKeys(root);
                      } catch (error) {
                        toast(describeError(error, "Could not revoke"), "err");
                      }
                    },
                  },
                  "Revoke",
                ),
              ),
        width: 150,
      },
    ],
    rows: keys,
    defaultSort: { key: "last", dir: "desc" },
    search: (row) => `${row.name} ${row.key_prefix} ${row.user_email} ${row.id}`,
    searchPlaceholder: "Search API keys…",
    emptyTitle: "No API keys",
    emptyHint: "Create a key to call the HTTP /send endpoint from your applications.",
    emptyAction: h(
      "button",
      {
        type: "button",
        class: "btn primary",
        "on:click": () => openNewApiKey(users, senders, () => renderApiKeys(root)),
      },
      icon("plus", 12),
      "New API key",
    ) as Child,
  });
  setChildren(target, built.root);
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
