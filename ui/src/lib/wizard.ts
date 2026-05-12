// "Set up sender" wizard — strings user creation, sender allowlist, and a
// fresh SMTP credential into one continuous flow. This is the canonical path
// admins should take when on-boarding a person or application for SMTP sending.

import { api, describeError } from "./api";
import { h, icon, setChildren } from "./dom";
import { closeModal, openModal, setModalBody, setModalFooter, secretRevealBody } from "./modal";
import { toast, copy } from "./toast";
import type { ApiKey, Domain, Sender, SmtpCredential, User } from "./types";

interface WizardSnapshot {
  users: User[];
  senders: Sender[];
  credentials: SmtpCredential[];
  apiKeys: ApiKey[];
}

interface WizardInit {
  snapshot: WizardSnapshot;
  onDone: () => void;
}

interface WizardState {
  step: number;
  user?: User | { id: string; email: string };
  domain?: Domain;
  senderEmail?: string;
  credential?: { username: string; secret: string };
}

const STEP_LABELS = ["User", "Domain", "Sender", "Credential", "Done"] as const;

export async function runUserWizard(init: WizardInit) {
  let state: WizardState = { step: 0 };
  let domains: Domain[] = [];
  try {
    domains = await api.listDomains();
  } catch {
    domains = [];
  }

  const reuseUser = init.snapshot.users.length > 0;

  function header(): HTMLElement {
    return h(
      "div",
      { class: "stack", style: "gap: 10px" },
      h("div", { class: "steps" }, ...stepsRow(state.step)),
      h("div", { class: "soft", style: "font-size: 13px" }, hint(state.step)),
    );
  }

  function render() {
    switch (state.step) {
      case 0:
        return stepUser();
      case 1:
        return stepDomain();
      case 2:
        return stepSender();
      case 3:
        return stepCredential();
      case 4:
        return stepDone();
      default:
        return h("div", null, "Unknown step");
    }
  }

  function repaint() {
    setModalBody(h("div", { class: "stack", style: "gap: 16px" }, header(), render()));
    setModalFooter(footer());
  }

  function footer(): HTMLElement | null {
    if (state.step === 4) {
      return h(
        "div",
        { class: "row-between flex-fill" },
        h("span", { class: "soft", style: "font-size: 12px" }, state.domain?.status === "verified" ? "All set up" : "Verify domain before first send"),
        h(
          "button",
          {
            type: "button",
            class: "btn primary",
            "on:click": () => {
              closeModal();
              init.onDone();
            },
          },
          icon("check", 13),
          "Done",
        ),
      );
    }
    return h(
      "div",
      { class: "row-between flex-fill" },
      h(
        "button",
        {
          type: "button",
          class: "btn ghost",
          "on:click": () => closeModal(),
        },
        "Cancel",
      ),
      h("div", { class: "row", style: "gap: 8px" }, backBtn(), nextBtn()),
    );
  }

  function backBtn(): HTMLElement | false {
    if (state.step === 0) return false;
    return h(
      "button",
      {
        type: "button",
        class: "btn ghost",
        "on:click": () => {
          state.step -= 1;
          repaint();
        },
      },
      "Back",
    );
  }

  function nextBtn(): HTMLElement {
    return h(
      "button",
      {
        type: "button",
        class: "btn primary",
        "data-role": "next",
        "on:click": () => advance().catch((err) => toast(err instanceof Error ? err.message : "Failed", "err")),
      },
      state.step === 3 ? "Create credential" : "Continue",
      icon("arrowRight", 13),
    );
  }

  async function advance() {
    if (state.step === 0) {
      // user step: validate and create-or-reuse
      const form = document.querySelector<HTMLFormElement>("[data-wizard-form='user']");
      if (!form) return;
      const data = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
      if (data.mode === "existing" && data.user_id) {
        const existing = init.snapshot.users.find((u) => u.id === data.user_id);
        if (existing) {
          state.user = existing;
          state.step = 1;
          repaint();
          return;
        }
      }
      if (!data.email) {
        toast("Email is required", "err");
        return;
      }
      try {
        const result = await api.createUser({
          email: data.email,
          display_name: data.display_name || undefined,
          role: data.role === "admin" ? "admin" : "sender",
        });
        state.user = { id: result.id, email: data.email };
        toast(`User ${data.email} created`);
        state.step = 1;
        repaint();
      } catch (error) {
        const message = describeError(error, "Could not create user.");
        toast(message, "err");
      }
      return;
    }
    if (state.step === 1) {
      const form = document.querySelector<HTMLFormElement>("[data-wizard-form='domain']");
      if (!form) return;
      const data = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
      if (data.mode === "existing" && data.domain_id) {
        const existing = domains.find((d) => d.id === data.domain_id);
        if (existing) {
          state.domain = existing;
          state.step = 2;
          repaint();
          return;
        }
      }
      if (!data.domain) {
        toast("Domain is required", "err");
        return;
      }
      try {
        const result = await api.createDomain({
          domain: data.domain,
          cloudflare_zone_id: data.cloudflare_zone_id || undefined,
          status: "pending",
        });
        state.domain = {
          id: result.id,
          domain: data.domain,
          cloudflare_zone_id: data.cloudflare_zone_id || null,
          status: "pending",
          dkim_status: null,
          spf_status: null,
          dmarc_status: null,
          enabled: 1,
          created_at: Date.now() / 1000,
          updated_at: Date.now() / 1000,
        };
        domains.push(state.domain);
        toast(`Domain ${data.domain} added`);
        state.step = 2;
        repaint();
      } catch (error) {
        const message = describeError(error, "Could not create domain.");
        toast(message, "err");
      }
      return;
    }
    if (state.step === 2) {
      const form = document.querySelector<HTMLFormElement>("[data-wizard-form='sender']");
      if (!form) return;
      const data = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
      if (!data.email) {
        toast("Sender address is required", "err");
        return;
      }
      if (!state.domain || !state.user) {
        toast("Wizard state invalid", "err");
        return;
      }
      try {
        await api.createSender({
          domain_id: state.domain.id,
          email: data.email,
          user_id: state.user.id,
        });
        state.senderEmail = data.email;
        toast("Sender granted");
        state.step = 3;
        repaint();
      } catch (error) {
        const message = describeError(error, "Could not grant sender.");
        toast(message, "err");
      }
      return;
    }
    if (state.step === 3) {
      const form = document.querySelector<HTMLFormElement>("[data-wizard-form='credential']");
      if (!form) return;
      const data = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
      if (!data.name || !data.username) {
        toast("Label and username are required", "err");
        return;
      }
      if (!state.user) {
        toast("Wizard state invalid", "err");
        return;
      }
      try {
        const result = await api.createSmtpCredential({
          user_id: state.user.id,
          name: data.name,
          username: data.username,
        });
        state.credential = { username: result.username ?? "", secret: result.secret };
        toast("Credential created");
        state.step = 4;
        repaint();
      } catch (error) {
        const message = describeError(error, "Could not create credential.");
        toast(message, "err");
      }
      return;
    }
  }

  // ───────────────── Step bodies ─────────────────

  function stepUser(): HTMLElement {
    const mode = reuseUser ? "existing" : "new";
    const form = h("form", { "data-wizard-form": "user", class: "stack", style: "gap: 12px" }) as HTMLFormElement;

    const modeRow = h(
      "div",
      { class: "row", style: "gap: 12px" },
      reuseUser
        ? h(
            "label",
            { class: "row", style: "gap: 6px; font-size: 13px" },
            h("input", { type: "radio", name: "mode", value: "existing", checked: mode === "existing", "on:change": () => repaintFormVisibility() }),
            "Existing user",
          )
        : false,
      h(
        "label",
        { class: "row", style: "gap: 6px; font-size: 13px" },
        h("input", { type: "radio", name: "mode", value: "new", checked: mode === "new" || !reuseUser, "on:change": () => repaintFormVisibility() }),
        "New user",
      ),
    );

    const existingBlock = h(
      "div",
      { class: "field", "data-existing": "1" },
      h("label", null, "Choose user"),
      h(
        "select",
        { class: "input", name: "user_id" },
        ...init.snapshot.users.map((u) => h("option", { value: u.id }, u.email)),
      ),
    );

    const newBlock = h(
      "div",
      { class: "stack", style: "gap: 10px", "data-new": "1" },
      h(
        "div",
        { class: "field" },
        h("label", { for: "wiz-email" }, "Email"),
        h("div", { class: "input" }, h("input", { id: "wiz-email", type: "email", name: "email", required: true, placeholder: "alex@example.com", autocomplete: "email" })),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: "wiz-name" }, "Display name (optional)"),
        h("div", { class: "input" }, h("input", { id: "wiz-name", type: "text", name: "display_name", placeholder: "Alex" })),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: "wiz-role" }, "Role"),
        h(
          "select",
          { id: "wiz-role", class: "input", name: "role" },
          h("option", { value: "sender" }, "sender — owns credentials, no admin access"),
          h("option", { value: "admin" }, "admin — can sign into this dashboard"),
        ),
      ),
    );

    form.appendChild(modeRow);
    form.appendChild(existingBlock);
    form.appendChild(newBlock);

    function repaintFormVisibility() {
      const selected = (form.querySelector("input[name='mode']:checked") as HTMLInputElement | null)?.value ?? "new";
      existingBlock.style.display = selected === "existing" ? "" : "none";
      newBlock.style.display = selected === "new" ? "" : "none";
    }
    repaintFormVisibility();
    return form;
  }

  function stepDomain(): HTMLElement {
    const hasDomains = domains.length > 0;
    const mode = hasDomains ? "existing" : "new";
    const form = h("form", { "data-wizard-form": "domain", class: "stack", style: "gap: 12px" }) as HTMLFormElement;

    const modeRow = h(
      "div",
      { class: "row", style: "gap: 12px" },
      hasDomains
        ? h(
            "label",
            { class: "row", style: "gap: 6px; font-size: 13px" },
            h("input", { type: "radio", name: "mode", value: "existing", checked: mode === "existing", "on:change": () => repaintFormVisibility() }),
            "Use existing domain",
          )
        : false,
      h(
        "label",
        { class: "row", style: "gap: 6px; font-size: 13px" },
        h("input", { type: "radio", name: "mode", value: "new", checked: mode === "new" || !hasDomains, "on:change": () => repaintFormVisibility() }),
        "Add new domain",
      ),
    );

    const existingBlock = h(
      "div",
      { class: "field", "data-existing": "1" },
      h("label", null, "Choose domain"),
      h(
        "select",
        { class: "input", name: "domain_id" },
        ...domains.map((d) => h("option", { value: d.id }, `${d.domain} (${d.status})`)),
      ),
    );

    const newBlock = h(
      "div",
      { class: "stack", style: "gap: 10px", "data-new": "1" },
      h(
        "div",
        { class: "field" },
        h("label", null, "Domain"),
        h("div", { class: "input" }, h("input", { type: "text", name: "domain", placeholder: "example.com", required: true })),
      ),
      h(
        "div",
        { class: "field" },
        h("label", null, "Cloudflare Zone ID (optional)"),
        h("div", { class: "input" }, h("input", { type: "text", name: "cloudflare_zone_id", placeholder: "—" })),
        h("div", { class: "hint" }, "Email Sending must be verified for this domain in Cloudflare. You can paste the Zone ID later from the domain detail page."),
      ),
    );

    form.appendChild(modeRow);
    form.appendChild(existingBlock);
    form.appendChild(newBlock);

    function repaintFormVisibility() {
      const selected = (form.querySelector("input[name='mode']:checked") as HTMLInputElement | null)?.value ?? "new";
      existingBlock.style.display = selected === "existing" ? "" : "none";
      newBlock.style.display = selected === "new" ? "" : "none";
    }
    repaintFormVisibility();
    return form;
  }

  function stepSender(): HTMLElement {
    const userLabel = state.user?.email ?? "—";
    const domain = state.domain?.domain ?? "—";
    return h(
      "form",
      { "data-wizard-form": "sender", class: "stack", style: "gap: 12px" },
      h(
        "div",
        { class: "banner" },
        icon("info", 14),
        h(
          "div",
          null,
          "Granting permission for ",
          h("span", { class: "mono" }, userLabel),
          " to send as an address on ",
          h("span", { class: "mono" }, domain),
          ".",
        ),
      ),
      h(
        "div",
        { class: "field" },
        h("label", null, "Sender address"),
        h(
          "div",
          { class: "input" },
          h("input", {
            type: "text",
            name: "email",
            placeholder: `alex@${domain} or *@${domain}`,
            required: true,
            value: state.user?.email && state.domain ? `${(state.user.email.split("@")[0] ?? "")}@${state.domain.domain}` : "",
          }),
        ),
        h("div", { class: "hint" }, "Use the full sender address for this SMTP identity. Or use *@domain for any address on the domain."),
      ),
    );
  }

  function stepCredential(): HTMLElement {
    const userLabel = state.user?.email ?? "";
    const suggested = (userLabel.split("@")[0] ?? "relay").replace(/\W+/g, "-").toLowerCase() || "relay";
    return h(
      "form",
      { "data-wizard-form": "credential", class: "stack", style: "gap: 12px" },
      h(
        "div",
        { class: "banner" },
        icon("info", 14),
        "Generates the SMTP secret for a mail client or application. We show it once.",
      ),
      h(
        "div",
        { class: "field" },
        h("label", null, "Label"),
        h("div", { class: "input" }, h("input", { type: "text", name: "name", placeholder: "Laptop mail client", value: `SMTP · ${suggested}`, required: true })),
      ),
      h(
        "div",
        { class: "field" },
        h("label", null, "SMTP username"),
        h("div", { class: "input" }, h("input", { type: "text", name: "username", placeholder: suggested, value: suggested, required: true })),
        h("div", { class: "hint" }, "Use this as the SMTP username. Choose something memorable — usernames must be unique."),
      ),
    );
  }

  function stepDone(): HTMLElement {
    const user = state.user?.email ?? "";
    const sender = state.senderEmail ?? "";
    const credential = state.credential;
    if (!credential) return h("div", null, "No credential created.");
    const domainVerified = state.domain?.status === "verified";
    return h(
      "div",
      { class: "stack", style: "gap: 14px" },
      h(
        "div",
        { class: `banner ${domainVerified ? "ok" : "warn"}` },
        icon(domainVerified ? "check" : "warn", 14),
        h(
          "div",
          null,
          h("strong", null, domainVerified ? "Sender ready." : "Credential created."),
          h(
            "div",
            { class: "soft", style: "font-size: 12.5px; margin-top: 2px" },
            domainVerified ? `${user} can now send as ` : `${user} can send as `,
            h("span", { class: "mono" }, sender),
            domainVerified ? "." : " after the domain is verified for Cloudflare Email Sending.",
          ),
        ),
      ),
      secretRevealBody({
        title: "SMTP credential",
        meta: [
          { label: "Username", value: credential.username, mono: true },
          { label: "SMTP host", value: "your relay's hostname, port 587, STARTTLS" },
        ],
        secret: credential.secret,
        warning: domainVerified
          ? "Save this SMTP password now. It will not be shown again."
          : "Save this SMTP password now. It will not be shown again. Sending will fail until the domain is verified.",
      }),
      h(
        "div",
        { class: "row", style: "gap: 8px; justify-content: flex-end" },
        h(
          "button",
          {
            type: "button",
            class: "btn ghost",
            "on:click": () => copy(credential.secret, "Secret copied"),
          },
          icon("copy", 12),
          "Copy secret again",
        ),
      ),
    );
  }

  function stepsRow(active: number): HTMLElement[] {
    return STEP_LABELS.map((label, index) =>
      h(
        "span",
        { class: `step${index === active ? " active" : ""}${index < active ? " done" : ""}` },
        h("span", { class: "dot" }),
        label,
        index < STEP_LABELS.length - 1 ? h("span", { class: "arrow" }, "→") : "",
      ),
    );
  }

  function hint(step: number): string {
    switch (step) {
      case 0:
        return reuseUser
          ? "Pick an existing user or create a new one. Senders, credentials, and API keys all belong to a user."
          : "Create the first user. Senders and credentials belong to a user.";
      case 1:
        return "Choose which domain this user will send from. The domain must be enabled for Email Sending in your Cloudflare account.";
      case 2:
        return "Grant permission for this user to send as a specific address on the domain.";
      case 3:
        return "Mint the SMTP password. Use the username + secret in your SMTP client or application.";
      case 4:
        return state.domain?.status === "verified"
          ? "All set — copy the secret now, it cannot be retrieved later."
          : "Copy the secret now. The credential is stored, but sending waits on domain verification.";
      default:
        return "";
    }
  }

  openModal({
    title: "Set up sender",
    body: h("div", null, "Loading…"),
    width: 620,
  });
  repaint();
}

// Used in step body to declare unused imports — keeps the bundler from complaining.
void setChildren;
