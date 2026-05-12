import { api, describeError } from "../api";
import type { Child } from "../dom";
import { h, icon, setChildren } from "../dom";
import { copyable } from "../clipboard";
import { formatAbsolute, formatRelative, initialsFor } from "../format";
import { buildForm, closeModal, openModal } from "../modal";
import { pill } from "../status";
import { toast } from "../toast";
import { openNewSender, openSenderDrawer } from "./senders";
import { openCredentialDrawer, openNewCredential } from "./credentials";
import { openApiKeyDrawer, openNewApiKey } from "./api-keys";
import type { ApiKey, Domain, Sender, SmtpCredential, User } from "../types";

interface DetailData {
  user: User;
  senders: Sender[];
  credentials: SmtpCredential[];
  apiKeys: ApiKey[];
  allDomains: Domain[];
  allUsers: User[];
  allSenders: Sender[];
}

export async function renderUserDetail(root: HTMLElement, id: string) {
  setChildren(
    root,
    head(null),
    h("div", { id: "user-detail-body" }, h("div", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "skeleton" })))),
  );

  let data: DetailData;
  try {
    const [users, allSenders, credentials, apiKeys, domains] = await Promise.all([
      api.listUsers(),
      api.listSenders(),
      api.listSmtpCredentials(),
      api.listApiKeys(),
      api.listDomains(),
    ]);
    const user = users.find((u) => u.id === id);
    if (!user) {
      notFound(root);
      return;
    }
    data = {
      user,
      senders: allSenders.filter((s) => s.user_id === id),
      credentials: credentials.filter((c) => c.user_id === id),
      apiKeys: apiKeys.filter((k) => k.user_id === id),
      allDomains: domains,
      allUsers: users,
      allSenders,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load user.";
    const body = root.querySelector<HTMLElement>("#user-detail-body");
    if (body) setChildren(body, h("div", { class: "banner bad" }, icon("warn", 14), message));
    return;
  }

  paint(root, data);
}

function head(user: User | null): HTMLElement {
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
        h("a", { href: "#/users" }, "users"),
        h("span", { class: "sep" }, "/"),
        h("span", null, user?.email ?? "…"),
      ),
      h(
        "div",
        { class: "row", style: "gap: 12px; align-items: center; margin-top: 4px" },
        h(
          "span",
          { class: "avatar", style: "width: 38px; height: 38px; border-radius: 99px; background: var(--accent-soft-strong); color: var(--accent-ink-on-soft); display: grid; place-items: center; font-size: 14px; font-weight: 600;" },
          user ? initialsFor(user.email) : "•",
        ),
        h(
          "div",
          null,
          h("h1", null, user?.display_name ?? user?.email ?? "User"),
          user?.display_name ? h("span", { class: "soft", style: "font-size: 13px" }, user.email) : false,
        ) as Child,
      ),
    ),
    h(
      "div",
      { class: "actions" },
      h("a", { href: "#/users", class: "btn ghost" }, "Back"),
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
        h("div", { class: "empty-title" }, "User not found"),
        h("div", { class: "empty-sub" }, "The user may have been removed."),
        h("div", { class: "empty-actions" }, h("a", { class: "btn", href: "#/users" }, "Back to users")),
      ),
    ),
  );
}

function paint(root: HTMLElement, data: DetailData) {
  setChildren(
    root,
    head(data.user),
    h(
      "div",
      { class: "spread" },
      summaryCard(data.user, root),
      sendersCard(data, root),
      credentialsCard(data, root),
      apiKeysCard(data, root),
    ),
  );
}

function summaryCard(user: User, root: HTMLElement): HTMLElement {
  return h(
    "div",
    { class: "card" },
    h(
      "div",
      { class: "card-head" },
      h("h2", null, "Profile"),
      h(
        "div",
        { class: "row", style: "gap: 6px" },
        h(
          "button",
          {
            type: "button",
            class: "btn ghost sm",
            "on:click": () => openEditUser(user, () => renderUserDetail(root, user.id)),
          },
          "Edit",
        ),
        user.disabled_at
          ? h(
              "button",
              {
                type: "button",
                class: "btn ghost sm",
                "on:click": async () => {
                  try {
                    await api.updateUser(user.id, { disabled_at: null });
                    toast(`${user.email} re-enabled`);
                    await renderUserDetail(root, user.id);
                  } catch (error) {
                    toast(describeError(error, "Could not enable"), "err");
                  }
                },
              },
              "Enable",
            )
          : h(
              "button",
              {
                type: "button",
                class: "btn ghost sm danger",
                "on:click": async () => {
                  if (!confirm(`Disable ${user.email}? They will lose access immediately on next request.`)) return;
                  try {
                    await api.updateUser(user.id, { disabled_at: "now" });
                    toast(`${user.email} disabled`);
                    await renderUserDetail(root, user.id);
                  } catch (error) {
                    toast(describeError(error, "Could not disable"), "err");
                  }
                },
              },
              "Disable",
            ),
      ),
    ),
    h(
      "div",
      { class: "card-body" },
      h(
        "dl",
        { class: "dl" },
        h("dt", null, "Email"), h("dd", null, copyable({ value: user.email, display: user.email })),
        h("dt", null, "Display name"), h("dd", null, user.display_name ?? h("span", { class: "soft" }, "—")),
        h("dt", null, "Role"), h("dd", null, pill(user.role, user.role === "admin" ? "info" : "muted")),
        h("dt", null, "Access subject"), h("dd", null, user.access_subject ? copyable({ value: user.access_subject }) : h("span", { class: "soft" }, "not yet signed in")),
        h("dt", null, "User ID"), h("dd", null, copyable({ value: user.id })),
        h("dt", null, "State"), h("dd", null, user.disabled_at ? pill("disabled", "muted") : pill("active", "ok")),
        h("dt", null, "Created"), h("dd", { class: "soft" }, formatAbsolute(user.created_at)),
      ),
    ),
  );
}

function openEditUser(user: User, onSaved: () => void): void {
  const { form, setBanner, busy } = buildForm(
    [
      {
        name: "display_name",
        label: "Display name",
        placeholder: "Alex",
        value: user.display_name ?? "",
        hint: "Leave blank to clear.",
      },
      {
        name: "role",
        label: "Role",
        kind: "select",
        value: user.role,
        options: [
          { value: "admin", label: "admin" },
          { value: "sender", label: "sender" },
        ],
      },
    ],
    async (raw) => {
      setBanner(null);
      busy(true);
      try {
        await api.updateUser(user.id, {
          display_name: raw.display_name.length === 0 ? null : raw.display_name,
          role: raw.role === "admin" ? "admin" : "sender",
        });
        toast("User updated");
        closeModal();
        onSaved();
      } catch (error) {
        setBanner(describeError(error, "Could not update user."));
        busy(false);
      }
    },
  );
  const submit = h("button", { type: "submit", class: "btn primary" }, "Save");
  const cancel = h("button", { type: "button", class: "btn ghost", "on:click": () => closeModal() }, "Cancel");
  submit.addEventListener("click", () => form.requestSubmit());
  openModal({
    title: `Edit ${user.email}`,
    body: form,
    footer: h("div", { class: "row-between flex-fill" }, cancel, submit),
  });
}

function sendersCard(data: DetailData, root: HTMLElement): HTMLElement {
  const head = h(
    "div",
    { class: "card-head" },
    h(
      "h2",
      null,
      "Allowed senders",
      h("span", { class: "soft", style: "margin-left: 10px; font-weight: 400; font-size: 13px" }, `· ${data.senders.length}`),
    ),
    h(
      "button",
      {
        type: "button",
        class: "btn ghost sm",
        "on:click": () => openNewSender(data.allDomains, data.allUsers, () => renderUserDetail(document.querySelector("#main")!, data.user.id), { userId: data.user.id }),
      },
      icon("plus", 12),
      "Grant sender",
    ),
  );

  if (data.senders.length === 0) {
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
          "This user can't send any mail until you grant them at least one sender. Without senders, credentials and API keys are useless.",
        ),
        h(
          "div",
          { class: "empty-actions" },
          h(
            "button",
            {
              type: "button",
              class: "btn primary",
              "on:click": () => openNewSender(data.allDomains, data.allUsers, () => renderUserDetail(document.querySelector("#main")!, data.user.id), { userId: data.user.id }),
            },
            icon("plus", 12),
            "Grant first sender",
          ),
        ),
      ),
    );
  }

  const list = h("div", { class: "stack", style: "gap: 0" });
  for (const sender of data.senders) {
    list.appendChild(senderRow(sender, data.user.id, root));
  }
  return h("div", { class: "card pad-0" }, head, list);
}

function senderRow(sender: Sender, userId: string, root: HTMLElement): HTMLElement {
  const enabled = sender.enabled === 1;
  return h(
    "button",
    {
      type: "button",
      class: "compact-row",
      "on:click": () => openSenderDrawer(sender, () => renderUserDetail(root, userId)),
    },
    h(
      "span",
      { class: "marker", style: "width: 14px; height: 14px; border-radius: 4px; display: grid; place-items: center; background: transparent; color: var(--text-mute)" },
      icon("user", 12),
    ),
    h(
      "span",
      { class: "label" },
      h(
        "span",
        { class: "primary" },
        h("span", { class: "id", style: "color: var(--text)" }, sender.email),
        enabled ? pill("enabled", "ok") : pill("disabled", "muted"),
      ),
      h("span", { class: "secondary" }, sender.domain),
    ),
    h("span", { class: "go" }, icon("chevronRight", 12)) as Child,
  );
}

function credentialsCard(data: DetailData, root: HTMLElement): HTMLElement {
  const head = h(
    "div",
    { class: "card-head" },
    h(
      "h2",
      null,
      "SMTP credentials",
      h("span", { class: "soft", style: "margin-left: 10px; font-weight: 400; font-size: 13px" }, `· ${data.credentials.length}`),
    ),
    h(
      "button",
      {
        type: "button",
        class: "btn ghost sm",
        "on:click": () => openNewCredential(data.allUsers, data.allSenders, () => renderUserDetail(root, data.user.id), { userId: data.user.id }),
      },
      icon("plus", 12),
      "New credential",
    ),
  );

  if (data.credentials.length === 0) {
    return h(
      "div",
      { class: "card pad-0" },
      head,
      h(
        "div",
        { class: "empty" },
        h("div", { class: "empty-title" }, "No SMTP credentials"),
        h("div", { class: "empty-sub" }, "This is the SMTP password for mail clients and applications."),
        h(
          "div",
          { class: "empty-actions" },
          h(
            "button",
            {
              type: "button",
              class: "btn primary",
              "on:click": () => openNewCredential(data.allUsers, data.allSenders, () => renderUserDetail(root, data.user.id), { userId: data.user.id }),
            },
            icon("plus", 12),
            "Create credential",
          ),
        ),
      ),
    );
  }

  const list = h("div", { class: "stack", style: "gap: 0" });
  for (const credential of data.credentials) {
    list.appendChild(credentialRow(credential, root));
  }
  return h("div", { class: "card pad-0" }, head, list);
}

function credentialRow(credential: SmtpCredential, root: HTMLElement): HTMLElement {
  return h(
    "button",
    {
      type: "button",
      class: "compact-row",
      "on:click": () => openCredentialDrawer(credential, () => renderUserDetail(root, credential.user_id)),
    },
    h(
      "span",
      { class: "label" },
      h(
        "span",
        { class: "primary" },
        h("span", { style: "font-weight: 500" }, credential.name),
        credential.revoked_at ? pill("revoked", "muted") : pill("active", "ok"),
      ),
      h(
        "span",
        { class: "secondary" },
        credential.username,
        " · ",
        credential.last_used_at ? `last used ${formatRelative(credential.last_used_at)}` : "never used",
      ),
    ),
    h("span", { class: "go" }, icon("chevronRight", 12)) as Child,
  );
}

function apiKeysCard(data: DetailData, root: HTMLElement): HTMLElement {
  const head = h(
    "div",
    { class: "card-head" },
    h(
      "h2",
      null,
      "API keys",
      h("span", { class: "soft", style: "margin-left: 10px; font-weight: 400; font-size: 13px" }, `· ${data.apiKeys.length}`),
    ),
    h(
      "button",
      {
        type: "button",
        class: "btn ghost sm",
        "on:click": () => openNewApiKey(data.allUsers, data.allSenders, () => renderUserDetail(root, data.user.id), { userId: data.user.id }),
      },
      icon("plus", 12),
      "New API key",
    ),
  );

  if (data.apiKeys.length === 0) {
    return h(
      "div",
      { class: "card pad-0" },
      head,
      h(
        "div",
        { class: "empty" },
        h("div", { class: "empty-title" }, "No API keys"),
        h("div", { class: "empty-sub" }, "For programmatic access to the HTTP /send endpoint."),
        h(
          "div",
          { class: "empty-actions" },
          h(
            "button",
            {
              type: "button",
              class: "btn primary",
              "on:click": () => openNewApiKey(data.allUsers, data.allSenders, () => renderUserDetail(root, data.user.id), { userId: data.user.id }),
            },
            icon("plus", 12),
            "Create API key",
          ),
        ),
      ),
    );
  }

  const list = h("div", { class: "stack", style: "gap: 0" });
  for (const key of data.apiKeys) {
    list.appendChild(apiKeyRow(key, root));
  }
  return h("div", { class: "card pad-0" }, head, list);
}

function apiKeyRow(key: ApiKey, root: HTMLElement): HTMLElement {
  return h(
    "button",
    {
      type: "button",
      class: "compact-row",
      "on:click": () => openApiKeyDrawer(key, () => renderUserDetail(root, key.user_id)),
    },
    h(
      "span",
      { class: "label" },
      h(
        "span",
        { class: "primary" },
        h("span", { style: "font-weight: 500" }, key.name),
        key.revoked_at ? pill("revoked", "muted") : pill("active", "ok"),
      ),
      h(
        "span",
        { class: "secondary" },
        key.key_prefix,
        " · ",
        key.last_used_at ? `last used ${formatRelative(key.last_used_at)}` : "never used",
      ),
    ),
    h("span", { class: "go" }, icon("chevronRight", 12)) as Child,
  );
}
