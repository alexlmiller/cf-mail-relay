// Generic modal with header/body/footer, plus a fields-driven form helper
// and a secret-reveal pane shared by the credential / API key flows.

import type { Child } from "./dom";
import { h, icon, on, setChildren } from "./dom";
import { copyable } from "./clipboard";
import { copy } from "./toast";

export interface ModalOptions {
  title: string;
  body: Child;
  footer?: Child;
  width?: number;
  onClose?: () => void;
}

let backdrop: HTMLElement | null = null;
let modal: HTMLElement | null = null;
let body: HTMLElement | null = null;
let foot: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let onClose: (() => void) | null = null;
let escDisposer: (() => void) | null = null;

function ensureMounted() {
  if (backdrop && modal) return;
  backdrop = h("div", { class: "modal-backdrop" });
  modal = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "modal-title" });
  titleEl = h("h2", { id: "modal-title" });
  const closeBtn = h(
    "button",
    {
      type: "button",
      class: "iconbtn",
      "aria-label": "Close",
      title: "Close (Esc)",
      "on:click": () => closeModal(),
    },
    icon("x", 16),
  );
  modal.appendChild(h("header", { class: "modal-head" }, titleEl, closeBtn));
  body = h("div", { class: "modal-body" });
  foot = h("footer", { class: "modal-foot hidden" });
  modal.appendChild(body);
  modal.appendChild(foot);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  on(backdrop, "click", (event) => {
    if (event.target === backdrop) closeModal();
  });
}

export function openModal(options: ModalOptions) {
  ensureMounted();
  if (!backdrop || !modal || !body || !foot || !titleEl) return;
  titleEl.textContent = options.title;
  setChildren(body, options.body);
  if (options.footer) {
    foot.classList.remove("hidden");
    setChildren(foot, options.footer);
  } else {
    foot.classList.add("hidden");
    setChildren(foot);
  }
  if (options.width) modal.style.maxWidth = `${options.width}px`;
  onClose = options.onClose ?? null;
  requestAnimationFrame(() => backdrop?.classList.add("open"));
  escDisposer?.();
  escDisposer = on(window, "keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
    }
  });
  // Focus first focusable element.
  window.setTimeout(() => {
    const focusable = body?.querySelector<HTMLElement>("input,select,textarea,button");
    focusable?.focus();
  }, 50);
}

export function closeModal() {
  if (!backdrop) return;
  backdrop.classList.remove("open");
  onClose?.();
  onClose = null;
  escDisposer?.();
  escDisposer = null;
}

export function setModalBody(node: Child) {
  if (!body) return;
  setChildren(body, node);
}

export function setModalFooter(node: Child | null) {
  if (!foot) return;
  if (node === null) {
    foot.classList.add("hidden");
    setChildren(foot);
  } else {
    foot.classList.remove("hidden");
    setChildren(foot, node);
  }
}

// ───────────────────────── Forms ─────────────────────────

export type FieldKind = "text" | "email" | "select" | "textarea" | "hidden";

export interface FormField {
  name: string;
  label?: string;
  kind?: FieldKind;
  value?: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  autocomplete?: string;
  options?: Array<{ value: string; label: string }>;
  validate?: (value: string) => string | null;
}

export function buildForm(
  fields: FormField[],
  onSubmit: (values: Record<string, string>) => void,
): { form: HTMLFormElement; values: () => Record<string, string>; setError: (name: string, msg: string | null) => void; setBanner: (msg: string | null, kind?: "warn" | "bad") => void; busy: (state: boolean) => void } {
  const form = h("form", { class: "stack", style: "gap: 14px", "on:submit": (event) => {
    event.preventDefault();
    onSubmit(values());
  } });

  const errors = new Map<string, HTMLElement>();
  let bannerSlot: HTMLElement | null = null;

  for (const field of fields) {
    if (field.kind === "hidden") {
      form.appendChild(h("input", { type: "hidden", name: field.name, value: field.value ?? "" }));
      continue;
    }
    const inputId = `f-${field.name}`;
    const errorEl = h("div", { class: "error", hidden: true });
    errors.set(field.name, errorEl);

    let control: HTMLElement;
    if (field.kind === "select") {
      const select = h(
        "select",
        { id: inputId, name: field.name, class: "input" },
        ...(field.options ?? []).map((opt) =>
          h("option", { value: opt.value }, opt.label),
        ),
      ) as HTMLSelectElement;
      if (field.value !== undefined) select.value = field.value;
      control = select;
    } else if (field.kind === "textarea") {
      const ta = h("textarea", {
        id: inputId,
        name: field.name,
        class: "input",
        rows: 4,
        placeholder: field.placeholder ?? "",
        autocomplete: field.autocomplete ?? "off",
        spellcheck: false,
      }) as HTMLTextAreaElement;
      if (field.value !== undefined) ta.value = field.value;
      control = ta;
    } else {
      control = h("div", { class: "input" }, h("input", {
        id: inputId,
        type: field.kind ?? "text",
        name: field.name,
        placeholder: field.placeholder ?? "",
        autocomplete: field.autocomplete ?? "off",
        value: field.value ?? "",
        required: field.required ?? false,
        spellcheck: false,
      }));
    }

    const wrap = h(
      "div",
      { class: "field" },
      field.label ? h("label", { for: inputId }, field.label) : false,
      control,
      field.hint ? h("div", { class: "hint" }, field.hint) : false,
      errorEl,
    );
    form.appendChild(wrap);
  }

  bannerSlot = h("div", { class: "hidden" });
  form.appendChild(bannerSlot);

  function readField(field: FormField): string {
    const control = form.elements.namedItem(field.name);
    if (!control) return "";
    if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) {
      return control.value.trim();
    }
    return "";
  }

  function values(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const field of fields) {
      result[field.name] = readField(field);
    }
    return result;
  }

  function setError(name: string, msg: string | null) {
    const el = errors.get(name);
    if (!el) return;
    if (msg === null) {
      el.hidden = true;
      el.textContent = "";
    } else {
      el.hidden = false;
      el.textContent = msg;
    }
  }

  function setBanner(msg: string | null, kind: "warn" | "bad" = "bad") {
    if (!bannerSlot) return;
    if (msg === null) {
      bannerSlot.className = "hidden";
      setChildren(bannerSlot);
      return;
    }
    bannerSlot.className = `banner ${kind}`;
    setChildren(bannerSlot, icon("warn", 14), msg);
  }

  function busy(state: boolean) {
    const buttons = form.querySelectorAll<HTMLButtonElement>("button[type='submit']");
    for (const btn of buttons) btn.disabled = state;
    form.dataset.busy = state ? "1" : "";
  }

  return { form, values, setError, setBanner, busy };
}

// ───────────────────────── Secret reveal pane ─────────────────────────

export interface SecretRevealOptions {
  title: string;
  /** Map of label → value rows shown above the secret. */
  meta?: Array<{ label: string; value: string; mono?: boolean }>;
  secret: string;
  warning?: string;
  onDone?: () => void;
}

export function secretRevealBody(options: SecretRevealOptions): HTMLElement {
  const wrap = h("div", { class: "stack", style: "gap: 14px" });

  for (const row of options.meta ?? []) {
    wrap.appendChild(
      h(
        "div",
        { class: "field" },
        h("label", null, row.label),
        h(
          "div",
          { class: "row-between" },
          h("span", { class: row.mono ? "mono" : "" }, row.value),
          h(
            "button",
            {
              type: "button",
              class: "btn sm ghost",
              "on:click": async () => {
                await copy(row.value, `${row.label} copied`);
              },
            },
            icon("copy", 12),
            "Copy",
          ),
        ),
      ),
    );
  }

  wrap.appendChild(h("div", { class: "section-title" }, "Secret"));
  const secretText = h("div", { class: "secret-text" }, options.secret);
  const copyBtn = h(
    "button",
    {
      type: "button",
      class: "btn primary",
      "on:click": async () => {
        await copy(options.secret, "Secret copied to clipboard");
      },
    },
    icon("copy", 14),
    "Copy secret",
  );

  wrap.appendChild(
    h(
      "div",
      { class: "secret-pane" },
      h("div", { class: "small" }, "Plaintext secret — shown once"),
      secretText,
      h(
        "div",
        { class: "row-between" },
        h("div", { class: "soft", style: "font-size: 12px" }, "Treat this like a password. It will not be shown again."),
        copyBtn,
      ),
    ),
  );

  if (options.warning) {
    wrap.appendChild(h("div", { class: "banner warn" }, icon("warn", 14), options.warning));
  }
  void copyable; // keep import live in case we ever inline copy chips here

  return wrap;
}
