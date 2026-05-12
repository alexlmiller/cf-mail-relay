// Sortable, filterable, searchable table.

import type { Child } from "./dom";
import { h, icon, on, setChildren } from "./dom";
import type { FilterChip } from "./status";

export interface ColumnDef<Row> {
  key: string;
  label: string;
  /** Renders the cell. */
  render: (row: Row) => Child;
  /** When defined, the column is sortable. */
  sort?: (row: Row) => number | string;
  /** Visual class on cells. */
  cell?: string;
  /** Width (px or e.g. "120px"). Falls back to natural width. */
  width?: number | string;
  /** Right-align the cell content. */
  right?: boolean;
  /**
   * In cardMode, render this cell as the card's title — full-width, no label,
   * with a separator below. Use for the row's main identifier (e.g. the
   * domain name, the credential label).
   */
  primary?: boolean;
  /**
   * In cardMode, hide this cell entirely on phone. Use for secondary detail
   * that's also reachable via the row's detail page (e.g. Zone ID, Created
   * date). Has no effect on desktop.
   */
  hideOnCard?: boolean;
  /**
   * In cardMode, drop the auto-rendered label column ("STATE ·") in front of
   * this cell's value. Use for self-explanatory pills (active/revoked,
   * enabled/disabled) where the label adds noise. The value still occupies a
   * full row, just without the leading label slot.
   */
  hideLabelOnCard?: boolean;
}

export interface TableOptions<Row> {
  columns: ColumnDef<Row>[];
  rows: Row[];
  /** Default sort key (column key). */
  defaultSort?: { key: string; dir: "asc" | "desc" };
  /** Function that returns the searchable haystack for a row. */
  search?: (row: Row) => string;
  /** Optional status-style filter chips. */
  chips?: FilterChip[];
  /** When chips are provided, this getter selects the value chips match against. */
  chipValue?: (row: Row) => string;
  searchPlaceholder?: string;
  emptyTitle?: string;
  emptyHint?: string;
  emptyAction?: Child;
  /** Click handler for the whole row. */
  onRowClick?: (row: Row) => void;
  /** Stable row id used for keys (not strictly required, helps avoid relayout). */
  rowId?: (row: Row) => string;
  /** Suppress the toolbar when there are no rows and no chips configured. */
  hideToolsWhenEmpty?: boolean;
  /**
   * Below the 720px breakpoint, repaint each row as a card stack instead of
   * forcing horizontal scroll. Cells use data-label attrs as their visual
   * label in card mode. Use for read-heavy mobile flows (events, failures).
   */
  cardMode?: boolean;
  /**
   * Render rows as a 2-line button list (homepage-style activity feed)
   * instead of a table. Drops the column headers — `defaultSort` pins the
   * order. Columns still drive search + chip filtering. Mutually exclusive
   * with cardMode (compact wins).
   */
  compact?: CompactRender<Row>;
}

export interface CompactRender<Row> {
  /** Left-side dot/icon. Use a coloured marker to convey status at a glance. */
  marker?: (row: Row) => Child;
  /** First line — typically status pill + main identifier + minor inline detail. */
  primary: (row: Row) => Child;
  /** Second line — typically a soft mono line of timestamp + ids. */
  secondary: (row: Row) => Child;
}

interface State {
  query: string;
  chip: string;
  sortKey: string | null;
  sortDir: "asc" | "desc";
}

export function buildTable<Row>(options: TableOptions<Row>): { root: HTMLElement; setRows: (rows: Row[]) => void } {
  const state: State = {
    query: "",
    chip: options.chips?.[0]?.key ?? "all",
    sortKey: options.defaultSort?.key ?? null,
    sortDir: options.defaultSort?.dir ?? "desc",
  };

  let allRows = options.rows;

  // Toolbar
  const searchInput = h("input", {
    type: "search",
    placeholder: options.searchPlaceholder ?? "Search…",
    autocomplete: "off",
    spellcheck: false,
  }) as HTMLInputElement;
  const search = h(
    "div",
    { class: "input search" },
    h("span", { class: "glyph" }, icon("search", 13)),
    searchInput,
  );
  on(searchInput, "input", () => {
    state.query = searchInput.value.trim().toLowerCase();
    render();
  });

  const chipRow = h("div", { class: "chip-row" });
  if (options.chips) {
    for (const chip of options.chips) {
      const button = h(
        "button",
        {
          type: "button",
          class: "chip",
          "aria-pressed": state.chip === chip.key ? "true" : "false",
          "data-key": chip.key,
          "on:click": () => {
            state.chip = chip.key;
            for (const b of chipRow.querySelectorAll<HTMLButtonElement>(".chip")) {
              b.setAttribute("aria-pressed", b.dataset.key === chip.key ? "true" : "false");
            }
            render();
          },
        },
        chip.label,
        h("span", { class: "count", "data-count": chip.key }, ""),
      );
      chipRow.appendChild(button);
    }
  }

  const toolbar = h("div", { class: "table-tools" }, options.chips ? chipRow : false, search);

  // Table head
  const thead = h("thead");
  const headRow = h("tr");
  for (const col of options.columns) {
    const sortable = col.sort !== undefined;
    const ariaSort = state.sortKey === col.key ? (state.sortDir === "asc" ? "ascending" : "descending") : "none";
    const th = h(
      "th",
      {
        class: sortable ? "sortable" : "",
        "aria-sort": ariaSort,
        style: col.width ? `width: ${typeof col.width === "number" ? `${col.width}px` : col.width};` : undefined,
        "on:click": sortable
          ? () => {
              if (state.sortKey === col.key) {
                state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
              } else {
                state.sortKey = col.key;
                state.sortDir = "desc";
              }
              syncSort();
              render();
            }
          : undefined,
      },
      col.label,
      sortable ? h("span", { class: "arr", "data-arr": col.key }, "") : false,
    );
    if (col.right) th.style.textAlign = "right";
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  const tbody = h("tbody");
  const table = h("table", { class: "list" }, thead, tbody);
  const tableWrap = h("div", { class: "table-wrap" }, table);
  const compactList = h("div", { class: "compact-list" });
  const empty = h("div", { class: "empty hidden" });
  const useCompact = options.compact !== undefined;
  const shellAttrs = useCompact
    ? { class: "table-shell compact-shell" }
    : options.cardMode
      ? { class: "table-shell", "data-cards": "1" }
      : { class: "table-shell" };
  const shell = h(
    "div",
    shellAttrs,
    options.chips || !options.hideToolsWhenEmpty || options.rows.length > 0 ? toolbar : false,
    useCompact ? compactList : tableWrap,
    empty,
  );

  function syncSort() {
    for (const th of headRow.querySelectorAll<HTMLElement>("th[aria-sort]")) {
      th.setAttribute("aria-sort", "none");
    }
    for (const arr of headRow.querySelectorAll<HTMLElement>(".arr")) {
      arr.textContent = "";
    }
    if (state.sortKey === null) return;
    const idx = options.columns.findIndex((c) => c.key === state.sortKey);
    if (idx === -1) return;
    const th = headRow.children[idx] as HTMLElement | undefined;
    if (!th) return;
    th.setAttribute("aria-sort", state.sortDir === "asc" ? "ascending" : "descending");
    const arr = th.querySelector<HTMLElement>(".arr");
    if (arr) arr.textContent = state.sortDir === "asc" ? "↑" : "↓";
  }

  function filtered(): Row[] {
    let rows = allRows;
    const chip = options.chips?.find((c) => c.key === state.chip);
    if (chip && options.chipValue) {
      rows = rows.filter((r) => chip.match(options.chipValue!(r)));
    }
    if (state.query.length > 0 && options.search) {
      const q = state.query;
      rows = rows.filter((r) => options.search!(r).toLowerCase().includes(q));
    }
    if (state.sortKey !== null) {
      const col = options.columns.find((c) => c.key === state.sortKey);
      if (col?.sort) {
        const dir = state.sortDir === "asc" ? 1 : -1;
        rows = [...rows].sort((a, b) => {
          const va = col.sort!(a);
          const vb = col.sort!(b);
          if (va === vb) return 0;
          if (va === null || va === undefined) return 1;
          if (vb === null || vb === undefined) return -1;
          return va > vb ? dir : -dir;
        });
      }
    }
    return rows;
  }

  function updateChipCounts() {
    if (!options.chips || !options.chipValue) return;
    for (const chip of options.chips) {
      const node = chipRow.querySelector<HTMLElement>(`[data-count="${chip.key}"]`);
      if (!node) continue;
      const count = chip.key === "all" ? allRows.length : allRows.filter((r) => chip.match(options.chipValue!(r))).length;
      node.textContent = String(count);
    }
  }

  function render() {
    syncSort();
    updateChipCounts();
    const visible = filtered();
    const surface = useCompact ? compactList : tableWrap;
    setChildren(tbody);
    setChildren(compactList);
    if (visible.length === 0) {
      empty.classList.remove("hidden");
      surface.classList.add("hidden");
      if (allRows.length === 0) {
        // Truly empty
        setChildren(
          empty,
          h("div", { class: "empty-title" }, options.emptyTitle ?? "Nothing here yet"),
          options.emptyHint ? h("div", { class: "empty-sub" }, options.emptyHint) : false,
          options.emptyAction ? h("div", { class: "empty-actions" }, options.emptyAction) : false,
        );
      } else {
        // Filtered away
        setChildren(
          empty,
          h("div", { class: "empty-title" }, "No matches"),
          h("div", { class: "empty-sub" }, "Try a different filter or search term."),
        );
      }
      return;
    }
    empty.classList.add("hidden");
    surface.classList.remove("hidden");

    if (useCompact) {
      renderCompact(visible);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const row of visible) {
      const tr = h("tr", options.onRowClick ? { class: "clickable" } : null);
      if (options.onRowClick) {
        on(tr, "click", () => options.onRowClick!(row));
        on(tr, "keydown", (event) => {
          if (event.key === "Enter") options.onRowClick!(row);
        });
        tr.tabIndex = 0;
      }
      for (const col of options.columns) {
        const td = h(
          "td",
          {
            class: col.cell ?? "",
            "data-label": col.label,
            "data-primary": col.primary ? "1" : undefined,
            "data-hide-card": col.hideOnCard ? "1" : undefined,
            "data-hide-label-card": col.hideLabelOnCard ? "1" : undefined,
          },
          col.render(row),
        );
        if (col.right) td.classList.add("right");
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
  }

  function renderCompact(rows: Row[]) {
    if (!options.compact) return;
    const compact = options.compact;
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const btn = h(
        "button",
        { type: "button", class: "compact-row" },
        compact.marker ? h("span", { class: "marker" }, compact.marker(row)) : false,
        h(
          "span",
          { class: "label" },
          h("span", { class: "primary" }, compact.primary(row)),
          h("span", { class: "secondary" }, compact.secondary(row)),
        ),
        options.onRowClick ? h("span", { class: "go" }, icon("chevronRight", 12)) : false,
      );
      if (options.onRowClick) {
        on(btn, "click", () => options.onRowClick!(row));
      } else {
        btn.disabled = true;
      }
      frag.appendChild(btn);
    }
    compactList.appendChild(frag);
  }

  syncSort();
  render();

  return {
    root: shell,
    setRows(rows: Row[]) {
      allRows = rows;
      render();
    },
  };
}
