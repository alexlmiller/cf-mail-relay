import { api, describeError } from "../api";
import type { Child } from "../dom";
import { h, icon, setChildren } from "../dom";
import { copyable } from "../clipboard";
import { formatRelative, initialsFor } from "../format";
import { buildForm, closeModal, openModal } from "../modal";
import { pill } from "../status";
import { buildTable } from "../table";
import { navigate, parse, replaceQuery } from "../router";
import { toast } from "../toast";
import { runUserWizard } from "../wizard";
import type { ApiKey, Sender, SmtpCredential, User } from "../types";

interface Snapshot {
  users: User[];
  senders: Sender[];
  credentials: SmtpCredential[];
  apiKeys: ApiKey[];
}

export async function renderUsers(root: HTMLElement) {
  setChildren(
    root,
    head(),
    h("div", { id: "users-table" }, h("div", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "skeleton" })))),
  );

  let snapshot: Snapshot;
  try {
    const [users, senders, credentials, apiKeys] = await Promise.all([
      api.listUsers(),
      api.listSenders(),
      api.listSmtpCredentials(),
      api.listApiKeys(),
    ]);
    snapshot = { users, senders, credentials, apiKeys };
  } catch (error) {
    const target = root.querySelector<HTMLElement>("#users-table");
    if (target) {
      const message = error instanceof Error ? error.message : "Could not load users.";
      setChildren(target, h("div", { class: "banner bad" }, icon("warn", 14), message));
    }
    return;
  }

  paint(root, snapshot);

  if (parse().query.get("new") === "1") {
    replaceQuery({ new: undefined });
    runUserWizard({ snapshot, onDone: () => renderUsers(root) });
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
        h("span", null, "users"),
      ),
      h("h1", null, "Users"),
      h(
        "div",
        { class: "soft", style: "margin-top: 6px; font-size: 13px; max-width: 64ch" },
        "Users own credentials and API keys. Open a user to grant senders, mint credentials, or review activity.",
      ),
    ),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          type: "button",
          class: "btn",
          "on:click": () => openCreateUserSimple(() => navigate("/users")),
          title: "Create a user without the guided flow",
        },
        icon("plus", 13),
        "New user",
      ),
      h(
        "button",
        {
          type: "button",
          class: "btn primary",
          "on:click": async () => {
            const [users, senders, credentials, apiKeys] = await Promise.all([
              api.listUsers(),
              api.listSenders(),
              api.listSmtpCredentials(),
              api.listApiKeys(),
            ]);
            runUserWizard({ snapshot: { users, senders, credentials, apiKeys }, onDone: () => navigate("/users") });
          },
        },
        icon("user", 13),
        "Set up sender",
      ),
    ),
  );
}

function paint(root: HTMLElement, snapshot: Snapshot) {
  const target = root.querySelector<HTMLElement>("#users-table");
  if (!target) return;

  const sendersByUser = countBy(snapshot.senders, (s) => s.user_id ?? "");
  const credsByUser = countBy(snapshot.credentials.filter((c) => c.revoked_at === null), (c) => c.user_id);
  const keysByUser = countBy(snapshot.apiKeys.filter((k) => k.revoked_at === null), (k) => k.user_id);

  const built = buildTable<User>({
    columns: [
      {
        key: "email",
        label: "User",
        primary: true,
        render: (row) =>
          h(
            "div",
            { class: "row", style: "gap: 10px; align-items: center; flex-wrap: wrap" },
            h(
              "span",
              { class: "avatar", style: "width: 28px; height: 28px; border-radius: 99px; background: var(--accent-soft-strong); color: var(--accent-ink-on-soft); display: grid; place-items: center; font-size: 11.5px; font-weight: 600;" },
              initialsFor(row.email),
            ),
            h(
              "div",
              { class: "stack", style: "gap: 1px" },
              h("span", { style: "font-weight: 500" }, row.email),
              row.display_name ? h("span", { class: "soft", style: "font-size: 12px" }, row.display_name) : false,
            ) as Child,
            pill(row.role, row.role === "admin" ? "info" : "muted"),
            row.disabled_at ? pill("disabled", "muted") : false,
          ),
        sort: (row) => row.email,
      },
      {
        key: "role",
        label: "Role",
        hideOnCard: true,
        render: (row) => pill(row.role, row.role === "admin" ? "info" : "muted"),
        sort: (row) => row.role,
        width: 100,
      },
      {
        key: "senders",
        label: "Senders",
        right: true,
        render: (row) => h("span", { class: "num" }, String(sendersByUser.get(row.id) ?? 0)),
        sort: (row) => sendersByUser.get(row.id) ?? 0,
        width: 100,
      },
      {
        key: "creds",
        label: "Creds",
        right: true,
        render: (row) => h("span", { class: "num" }, String(credsByUser.get(row.id) ?? 0)),
        sort: (row) => credsByUser.get(row.id) ?? 0,
        width: 90,
      },
      {
        key: "keys",
        label: "API keys",
        right: true,
        render: (row) => h("span", { class: "num" }, String(keysByUser.get(row.id) ?? 0)),
        sort: (row) => keysByUser.get(row.id) ?? 0,
        width: 90,
      },
      {
        key: "access",
        label: "Access sub",
        cell: "mono",
        hideOnCard: true,
        render: (row) =>
          row.access_subject
            ? copyable({ value: row.access_subject, display: row.access_subject.slice(0, 12), title: row.access_subject })
            : h("span", { class: "soft" }, "unbound"),
        width: 160,
      },
      {
        key: "state",
        label: "State",
        hideOnCard: true,
        render: (row) => (row.disabled_at ? pill("disabled", "muted") : pill("active", "ok")),
        sort: (row) => (row.disabled_at ? 1 : 0),
        width: 100,
      },
      {
        key: "created",
        label: "Joined",
        hideOnCard: true,
        render: (row) => h("span", { class: "soft" }, formatRelative(row.created_at)),
        sort: (row) => row.created_at,
        width: 130,
      },
    ],
    rows: snapshot.users,
    defaultSort: { key: "created", dir: "desc" },
    search: (row) => `${row.email} ${row.display_name ?? ""} ${row.role} ${row.access_subject ?? ""}`,
    searchPlaceholder: "Search users…",
    onRowClick: (row) => navigate(`/users/${row.id}`),
    emptyTitle: "No users yet",
    emptyHint: "Add the first user, then grant them senders and mint a credential. The Setup wizard walks you through it.",
    cardMode: true,
    emptyAction: h(
      "button",
      {
        type: "button",
        class: "btn primary",
        "on:click": () => runUserWizard({ snapshot, onDone: () => renderUsers(root) }),
      },
      icon("user", 12),
      "Set up sender",
    ) as Child,
  });

  setChildren(target, built.root);
}

function countBy<T>(rows: T[], getKey: (row: T) => string): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const key = getKey(row);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

export function openCreateUserSimple(onCreated: (id: string) => void) {
  const { form, setError, setBanner, busy } = buildForm(
    [
      { name: "email", label: "Email", kind: "email", required: true, placeholder: "alex@example.com", autocomplete: "email" },
      { name: "display_name", label: "Display name", placeholder: "Alex", hint: "Optional — shown in lists." },
      {
        name: "role",
        label: "Role",
        kind: "select",
        value: "sender",
        options: [
          { value: "admin", label: "admin (can sign into this dashboard)" },
          { value: "sender", label: "sender (owns credentials, no admin)" },
        ],
        hint: "Cloudflare Access governs sign-in; admins also need an Access policy that lets them through.",
      },
    ],
    async (raw) => {
      setError("email", null);
      setBanner(null);
      if (!raw.email) {
        setError("email", "Email is required.");
        return;
      }
      busy(true);
      try {
        const result = await api.createUser({
          email: raw.email,
          display_name: raw.display_name || undefined,
          role: raw.role === "admin" ? "admin" : "sender",
        });
        toast(`User ${raw.email} created`);
        closeModal();
        onCreated(result.id);
      } catch (error) {
        const message = describeError(error, "Could not create user.");
        setBanner(message);
        busy(false);
      }
    },
  );

  const submit = h("button", { type: "submit", class: "btn primary" }, "Create user");
  const cancel = h("button", { type: "button", class: "btn ghost", "on:click": () => closeModal() }, "Cancel");
  submit.addEventListener("click", () => form.requestSubmit());

  openModal({
    title: "New user",
    body: form,
    footer: h("div", { class: "row-between flex-fill" }, cancel, submit),
  });
}
