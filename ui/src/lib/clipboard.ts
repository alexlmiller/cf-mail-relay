// "Click-to-copy" element with a brief feedback affordance.

import { h, icon, setChildren } from "./dom";
import { copy } from "./toast";

export interface CopyableOptions {
  /** Display text. Falls back to the value when not given. */
  display?: string;
  /** Value that will be copied to the clipboard. */
  value: string;
  /** Optional tooltip. */
  title?: string;
  /** Add the leading copy glyph (default true). */
  withIcon?: boolean;
  /** Stop click events from bubbling (default true). Useful inside table rows. */
  stopPropagation?: boolean;
}

export function copyable(options: CopyableOptions): HTMLElement {
  const display = options.display ?? options.value;
  const withIcon = options.withIcon ?? true;
  const stop = options.stopPropagation ?? true;

  const node = h("button", {
    type: "button",
    class: "copy",
    title: options.title ?? "Click to copy",
    "data-value": options.value,
  });

  function render() {
    setChildren(
      node,
      h("span", { class: "copy-text" }, display),
      withIcon ? h("span", { class: "copy-glyph" }, icon("copy", 11)) : false,
    );
  }
  render();

  node.addEventListener("click", async (event) => {
    if (stop) event.stopPropagation();
    await copy(options.value, "Copied");
    node.classList.add("copied");
    window.setTimeout(() => node.classList.remove("copied"), 1100);
  });

  return node;
}
