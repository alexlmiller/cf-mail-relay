import { api, describeError } from "../api";
import type { Child } from "../dom";
import { h, icon, setChildren } from "../dom";
import { copyable } from "../clipboard";
import { close as closeDrawer, openDrawer } from "../drawer";
import { formatAbsolute, formatDayOnly } from "../format";
import { buildForm, closeModal, openModal } from "../modal";
import { pill } from "../status";
import { buildTable } from "../table";
import { navigate, parse, replaceQuery } from "../router";
import { toast } from "../toast";
import type { Domain, Sender, User } from "../types";

export async function renderSenders(root: HTMLElement) {
  setChildren(
    root,
    head(),
    h("div", { id: "senders-table" }, h("div", { class: "card" }, h("div", { class: "card-body" }, h("div", { class: "skeleton" })))),
  );

  let domains: Domain[] = [];
  let users: User[] = [];
  let senders: Sender[] = [];
  try {
    [domains, users, senders] = await Promise.all([
      api.listDomains(),
      api.listUsers(),
      api.listSenders(),
    ]);
  } catch (error) {
    paintError(root, error);
    return;
  }
  paint(root, senders, domains, users);

  const query = parse().query;
  if (query.get("new") === "1") {
    replaceQuery({ new: undefined });
    openNewSender(domains, users, () => renderSenders(root), {
      domainId: query.get("domain"),
      userId: query.get("user"),
    });
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
        h("span", null, "senders"),
      ),
      h("h1", null, "Allowed senders"),
      h(
        "div",
        { class: "soft", style: "margin-top: 6px; font-size: 13px; max-width: 64ch" },
        "Permissions table: who is allowed to send as what. A sender is an exact address (",
        h("span", { class: "mono" }, "alex@example.com"),
        ") or a wildcard (",
        h("span", { class: "mono" }, "*@example.com"),
        "). Each entry can be tied to a user — that user's credentials and API keys inherit it.",
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
            const [domains, users] = await Promise.all([api.listDomains(), api.listUsers()]);
            openNewSender(domains, users, () => navigate("/senders"));
          },
        },
        icon("plus", 13),
        "Grant sender",
      ),
    ),
  );
}

function paint(root: HTMLElement, senders: Sender[], domains: Domain[], users: User[]) {
  const target = root.querySelector<HTMLElement>("#senders-table");
  if (!target) return;
  const built = buildTable<Sender>({
    columns: [
      {
        key: "email",
        label: "Sender",
        primary: true,
        render: (row) => h(
          "span",
          { class: "row", style: "gap: 10px; flex-wrap: wrap; align-items: center" },
          h("span", { class: "id", style: "color: var(--text); font-size: 13px" }, row.email),
          row.enabled ? pill("enabled", "ok") : pill("disabled", "muted"),
        ),
        sort: (row) => row.email,
      },
      {
        key: "domain",
        label: "Domain",
        hideOnCard: true,
        render: (row) => h("a", { class: "id", href: `#/domains/${row.domain_id}`, "on:click": (event: Event) => event.stopPropagation() }, row.domain),
        sort: (row) => row.domain,
        width: 200,
      },
      {
        key: "user",
        label: "User",
        render: (row) =>
          row.user_email
            ? h("a", { class: "link", href: `#/users/${row.user_id ?? ""}`, "on:click": (event: Event) => event.stopPropagation() }, row.user_email)
            : h("span", { class: "soft" }, "any user"),
        sort: (row) => row.user_email ?? "",
        width: 240,
      },
      {
        key: "enabled",
        label: "State",
        hideOnCard: true,
        render: (row) => (row.enabled ? pill("enabled", "ok") : pill("disabled", "muted")),
        sort: (row) => (row.enabled ? 1 : 0),
        width: 110,
      },
      {
        key: "created",
        label: "Granted",
        hideOnCard: true,
        render: (row) => h("span", { class: "mono num soft" }, formatDayOnly(row.created_at)),
        sort: (row) => row.created_at,
        width: 130,
      },
      {
        key: "id",
        label: "ID",
        cell: "mono",
        hideOnCard: true,
        render: (row) => copyable({ value: row.id, display: row.id.slice(0, 12), title: row.id }),
        width: 150,
      },
      {
        key: "actions",
        label: "",
        hideOnCard: true,
        render: (row) => {
          const enabled = row.enabled === 1;
          return h(
            "div",
            { class: "row", style: "gap: 4px; justify-content: flex-end" },
            h(
              "button",
              {
                type: "button",
                class: "btn ghost sm",
                "on:click": async (event: Event) => {
                  event.stopPropagation();
                  try {
                    await api.updateSender(row.id, { enabled: !enabled });
                    toast(`${row.email} ${enabled ? "disabled" : "enabled"}`);
                    await renderSenders(root);
                  } catch (error) {
                    toast(describeError(error, "Could not update sender"), "err");
                  }
                },
              },
              enabled ? "Disable" : "Enable",
            ),
            h(
              "button",
              {
                type: "button",
                class: "btn ghost sm danger",
                "on:click": async (event: Event) => {
                  event.stopPropagation();
                  if (!confirm(`Remove ${row.email} from ${row.domain}? This is immediate and cannot be undone.`)) return;
                  try {
                    await api.deleteSender(row.id);
                    toast(`${row.email} removed`);
                    await renderSenders(root);
                  } catch (error) {
                    toast(describeError(error, "Could not delete sender"), "err");
                  }
                },
              },
              "Remove",
            ),
          );
        },
        width: 160,
      },
    ],
    rows: senders,
    defaultSort: { key: "created", dir: "desc" },
    search: (row) => `${row.email} ${row.domain} ${row.user_email ?? ""}`,
    searchPlaceholder: "Search by sender, domain, or user…",
    emptyTitle: "No allowed senders",
    emptyHint: "Grant a user permission to send as a specific address on one of your domains.",
    cardMode: true,
    onRowClick: (row) => openSenderDrawer(row, () => renderSenders(root)),
    emptyAction: h(
      "button",
      {
        type: "button",
        class: "btn primary",
        "on:click": () => openNewSender(domains, users, () => renderSenders(root)),
      },
      icon("plus", 12),
      "Grant sender",
    ) as Child,
  });
  setChildren(target, built.root);
}

function paintError(root: HTMLElement, error: unknown) {
  const target = root.querySelector<HTMLElement>("#senders-table");
  if (!target) return;
  const message = error instanceof Error ? error.message : "Could not load senders.";
  setChildren(target, h("div", { class: "banner bad" }, icon("warn", 14), message));
}

export interface NewSenderOptions {
  domainId?: string | null;
  userId?: string | null;
}

export function openNewSender(domains: Domain[], users: User[], onCreated: (id: string) => void, options: NewSenderOptions = {}) {
  if (domains.length === 0) {
    openModal({
      title: "Grant sender",
      body: h(
        "div",
        { class: "stack", style: "gap: 12px" },
        h("div", { class: "banner warn" }, icon("warn", 14), "Add a sending domain first — senders are scoped per domain."),
      ),
      footer: h(
        "div",
        { class: "row-between flex-fill" },
        h("button", { type: "button", class: "btn ghost", "on:click": () => closeModal() }, "Cancel"),
        h("button", { type: "button", class: "btn primary", "on:click": () => { closeModal(); navigate("/domains", { new: "1" }); } }, "Add domain"),
      ),
    });
    return;
  }

  const { form, setError, setBanner, busy } = buildForm(
    [
      {
        name: "domain_id",
        label: "Domain",
        kind: "select",
        value: options.domainId ?? domains[0]?.id ?? "",
        options: domains.map((d) => ({ value: d.id, label: d.domain })),
      },
      {
        name: "email",
        label: "Sender address",
        placeholder: "alex@example.com or *@example.com",
        required: true,
        hint: "Wildcards work — use *@example.com to allow any address on that domain.",
      },
      {
        name: "user_id",
        label: "Assign to user",
        kind: "select",
        value: options.userId ?? "",
        options: [
          { value: "", label: "— any user (domain-wide allowlist) —" },
          ...users.map((u) => ({ value: u.id, label: u.email })),
        ],
        hint: "When assigned, the user's credentials and API keys inherit this permission.",
      },
    ],
    async (raw) => {
      setError("email", null);
      setBanner(null);
      if (!raw.email) {
        setError("email", "Address is required.");
        return;
      }
      busy(true);
      try {
        const result = await api.createSender({
          domain_id: raw.domain_id,
          email: raw.email,
          user_id: raw.user_id || undefined,
        });
        toast("Sender granted");
        closeModal();
        onCreated(result.id);
      } catch (error) {
        const message = describeError(error, "Could not create sender.");
        setBanner(message);
        busy(false);
      }
    },
  );

  const submit = h("button", { type: "submit", class: "btn primary" }, "Grant sender");
  const cancel = h("button", { type: "button", class: "btn ghost", "on:click": () => closeModal() }, "Cancel");
  submit.addEventListener("click", () => form.requestSubmit());

  openModal({
    title: "Grant sender",
    body: form,
    footer: h("div", { class: "row-between flex-fill" }, cancel, submit),
  });
}

// ───────────────────────── Detail drawer ─────────────────────────

export function openSenderDrawer(
  sender: Sender,
  onChanged: () => Promise<void> | void,
): void {
  const enabled = sender.enabled === 1;
  const body = h(
    "div",
    { class: "stack", style: "gap: 18px" },
    h(
      "dl",
      { class: "dl" },
      h("dt", null, "Sender"), h("dd", null, h("span", { class: "id", style: "color: var(--text)" }, sender.email)),
      h("dt", null, "Domain"),
      h(
        "dd",
        null,
        h(
          "a",
          { class: "id", href: `#/domains/${sender.domain_id}`, "on:click": () => closeDrawer() },
          sender.domain,
        ),
      ),
      h("dt", null, "Owner"),
      h(
        "dd",
        null,
        sender.user_email
          ? h(
              "a",
              { class: "link", href: `#/users/${sender.user_id ?? ""}`, "on:click": () => closeDrawer() },
              sender.user_email,
            )
          : h("span", { class: "soft" }, "any user"),
      ),
      h("dt", null, "State"),
      h("dd", null, enabled ? pill("enabled", "ok") : pill("disabled", "muted")),
      h("dt", null, "Granted"), h("dd", { class: "soft" }, formatAbsolute(sender.created_at)),
      h("dt", null, "Updated"), h("dd", { class: "soft" }, formatAbsolute(sender.updated_at)),
      h("dt", null, "ID"), h("dd", null, copyable({ value: sender.id, display: sender.id })),
    ),
  );

  const footer = h(
    "div",
    { class: "row", style: "gap: 8px; flex-wrap: wrap; width: 100%" },
    h(
      "button",
      {
        type: "button",
        class: "btn ghost",
        "on:click": async () => {
          try {
            await api.updateSender(sender.id, { enabled: !enabled });
            toast(`${sender.email} ${enabled ? "disabled" : "enabled"}`);
            closeDrawer();
            await onChanged();
          } catch (error) {
            toast(describeError(error, "Could not update sender"), "err");
          }
        },
      },
      enabled ? "Disable" : "Enable",
    ),
    h("span", { class: "flex-fill" }),
    h(
      "button",
      {
        type: "button",
        class: "btn danger",
        "on:click": async () => {
          if (!confirm(`Remove ${sender.email} from ${sender.domain}? This is immediate and cannot be undone.`)) return;
          try {
            await api.deleteSender(sender.id);
            toast(`${sender.email} removed`);
            closeDrawer();
            await onChanged();
          } catch (error) {
            toast(describeError(error, "Could not delete sender"), "err");
          }
        },
      },
      "Remove",
    ),
  );

  openDrawer({
    title: sender.email,
    crumbs: [
      h("a", { href: "#/senders", "on:click": () => closeDrawer() }, "senders"),
      h("span", { class: "sep" }, "/"),
      h("span", null, sender.domain),
    ],
    body,
    footer,
  });
}
