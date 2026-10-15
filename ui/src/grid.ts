import { api, show, type Summary, type Val } from "./api";
import type { SortKey } from "./builder-sql";
import { PageCache } from "./pagecache";
import { nextSelection } from "./copyfmt";

const ROW_H = 30, PAGE = 200, MIN_W = 80, GUTTER = 52;
/** Pages kept in memory (~2,400 rows); older ones are dropped and fetched again from Rust if scrolled back to. */
const MAX_PAGES = 12;

type Kind = "num" | "text" | "time" | "bool" | "json";
/** Rough value family of a column, from its declared type. Drives alignment, width and the header glyph. */
function kindOf(type: string): Kind {
  const t = type.toLowerCase();
  if (/bool|bit\b|tinyint\(1\)/.test(t)) return "bool";
  if (/int|serial|dec|numeric|float|double|real|number|money|long/.test(t)) return "num";
  if (/date|time|year/.test(t)) return "time";
  if (/json|bson|array|object/.test(t)) return "json";
  return "text";
}
const GLYPH: Record<Kind, string> = { num: "#", text: "Aa", time: "◷", bool: "◐", json: "{}" };
const WIDTH: Record<Kind, number> = { num: 104, text: 190, time: 188, bool: 92, json: 220 };
const GLYPH_COLOR: Record<Kind, string> = { num: "var(--num)", text: "var(--muted)", time: "var(--date)", bool: "var(--ok)", json: "var(--tok-type)" };

/** Virtualized result grid: only visible rows are in the DOM; rows load in pages from Rust. */
export class Grid {
  el = document.createElement("div");
  private body = document.createElement("div");
  private head = document.createElement("div");
  private spacer = document.createElement("div");
  private rowsLayer = document.createElement("div");
  private cache = new PageCache<Val[][]>(MAX_PAGES);
  private loading = new Set<number>();
  /** A grid that isn't on screen keeps its result in Rust only; rows are fetched again when it comes back. */
  private suspended = false;
  private inflight = new Set<Promise<void>>();
  private widths: number[] = [];
  /** Selected rows (click, ⌘-click toggles, Shift-click ranges, ⌘A all). `anchor` is the row ranges grow from. */
  private rows = new Set<number>();
  private anchor = -1;
  /** Column of the active cell (the outlined one); its row is `anchor`. */
  private activeCol = -1;
  private allRows = false;
  private summary: Summary | null = null;

  // Row editing (table tabs): staged client-side until committed.
  editable = false;
  /** Result tabs edit cells only: no inserting or deleting rows. */
  rowOps = true;
  /** When set, only these result columns can be edited (the rest are expressions or duplicates). */
  editCols: boolean[] | null = null;
  /** Redraw after the owner changed what is editable. */
  repaint() { this.render(); }
  canEditCell(c: number) { return this.editable && (!this.editCols || !!this.editCols[c]); }
  onChange: () => void = () => {};
  /** Header click-to-sort; set `sortable` to show the affordance. `additive` = shift-click. */
  sortable = false;
  sort: SortKey[] = [];
  onSort: (col: string, additive: boolean, x: number, y: number) => void = () => {};
  /** Right-click on a cell (row index, column index) — the owner builds the menu. */
  onCellMenu: (x: number, y: number, row: number, col: number) => void = () => {};
  /** Column widths the user dragged, remembered by column name across re-sorts and reloads. */
  private userWidths = new Map<string, number>();
  private headCells: HTMLElement[] = [];
  edits = new Map<number, Map<number, Val>>();
  deleted = new Set<number>();
  inserted: Val[][] = [];

  constructor() {
    this.el.className = "h-full flex flex-col text-[13.5px] bg-panel";
    this.head.className = "flex overflow-hidden shrink-0";
    this.head.style.cssText = "background:var(--grid-head);border-bottom:1px solid var(--line-strong);height:34px";
    this.body.className = "flex-1 overflow-auto relative";
    this.spacer.style.position = "relative";
    this.rowsLayer.style.position = "absolute";
    this.rowsLayer.style.top = "0";
    this.spacer.append(this.rowsLayer);
    this.body.append(this.spacer);
    this.el.append(this.head, this.body);
    this.body.addEventListener("scroll", () => {
      this.head.scrollLeft = this.body.scrollLeft;
      this.render();
    });
    new ResizeObserver(() => this.render()).observe(this.body);
    // Delegated on the persistent rows layer: render() replaces every cell, so per-cell click handlers lose the second click of a double-click.
    this.body.tabIndex = 0;
    this.body.style.outline = "none";
    this.rowsLayer.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("input")) return;
      const rowEl = t.closest<HTMLElement>("[data-r]");
      if (!rowEl) return;
      const r = +rowEl.dataset.r!;
      const cell = t.closest<HTMLElement>("[data-c]");
      const col = cell ? +cell.dataset.c! : this.activeCol;
      this.body.focus({ preventScroll: true });
      const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey;
      if (plain && col === this.activeCol && this.anchor === r && this.rows.size === 1 && !this.allRows) return; // nothing changes: keep the DOM for the double-click
      this.activeCol = col;
      this.pick(r, e.shiftKey ? "range" : e.metaKey || e.ctrlKey ? "toggle" : "single");
    });
    this.rowsLayer.addEventListener("dblclick", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("input")) return;
      const rowEl = t.closest<HTMLElement>("[data-r]"), cell = t.closest<HTMLElement>("[data-c]");
      if (rowEl && cell) this.startEdit(+rowEl.dataset.r!, +cell.dataset.c!);
    });
    this.body.addEventListener("keydown", (e) => this.onKey(e));
  }

  /** Move the active cell (and select its row). */
  private move(dr: number, dc: number) {
    const n = this.total(), cols = this.summary?.columns.length ?? 0;
    if (!n || !cols) return;
    const first = this.anchor < 0 || this.activeCol < 0;
    const r = first ? Math.max(0, this.anchor) : Math.min(n - 1, Math.max(0, this.anchor + dr));
    this.activeCol = first ? Math.max(0, this.activeCol) : Math.min(cols - 1, Math.max(0, this.activeCol + dc));
    this.reveal(r, this.activeCol);
    this.setSelection(new Set([r]), r);
  }
  /** Scroll so the cell is fully in view. */
  private reveal(r: number, c: number) {
    const b = this.body, top = r * ROW_H;
    if (top < b.scrollTop) b.scrollTop = top;
    else if (top + ROW_H > b.scrollTop + b.clientHeight) b.scrollTop = top + ROW_H - b.clientHeight;
    const left = GUTTER + this.widths.slice(0, c).reduce((a, w) => a + w, 0), right = left + (this.widths[c] ?? 0);
    if (left - GUTTER < b.scrollLeft) b.scrollLeft = Math.max(0, left - GUTTER);
    else if (right > b.scrollLeft + b.clientWidth) b.scrollLeft = right - b.clientWidth;
  }
  private onKey(e: KeyboardEvent) {
    if (e.target !== this.body || !this.summary) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[e.key]) { e.preventDefault(); this.move(...arrows[e.key]); }
    else if (e.key === "Tab") { e.preventDefault(); this.move(0, e.shiftKey ? -1 : 1); }
    else if (e.key === "Enter" || e.key === "F2") { if (this.anchor >= 0 && this.activeCol >= 0 && this.canEditCell(this.activeCol)) { e.preventDefault(); this.startEdit(this.anchor, this.activeCol); } else if (e.key === "Enter") this.move(1, 0); }
    else if (e.key.length === 1 && this.anchor >= 0 && this.activeCol >= 0 && this.canEditCell(this.activeCol)) { e.preventDefault(); this.startEdit(this.anchor, this.activeCol, undefined, e.key); }
  }

  get columns() { return this.summary?.columns ?? []; }
  /** The primary selected row (the anchor), or -1. */
  get selected() { return this.anchor; }
  isSelected(r: number) { return this.allRows ? r < this.total() : this.rows.has(r); }
  get selectedCount() { return this.allRows ? this.total() : this.rows.size; }
  /** Selected row numbers, ascending. */
  selectedRows(): number[] {
    if (this.allRows) return Array.from({ length: this.total() }, (_, i) => i);
    return [...this.rows].sort((a, b) => a - b);
  }
  /** Called whenever the selection changes. */
  onSelect: () => void = () => {};
  private setSelection(rows: Set<number>, anchor: number, all = false) {
    this.rows = rows; this.anchor = anchor; this.allRows = all;
    this.render();
    this.onSelect();
  }
  pick(r: number, mode: "single" | "toggle" | "range") {
    const cur = this.allRows ? new Set(this.selectedRows()) : this.rows;
    const n = nextSelection(cur, this.anchor, r, mode);
    this.setSelection(n.rows, n.anchor);
  }
  selectAll() { if (this.total()) this.setSelection(new Set(), 0, true); }
  clearSelection() { if (this.anchor >= 0 || this.rows.size || this.allRows) this.setSelection(new Set(), -1); }
  /** Current values (staged edits included) of the given rows. Pages that aren't cached are fetched without caching them. */
  async rowValues(rows: number[]): Promise<Val[][]> {
    const s = this.summary;
    if (!s) return [];
    const fetched = new Map<number, Val[][]>();
    for (const p of new Set(rows.filter((r) => r < s.row_count).map((r) => Math.floor(r / PAGE)))) {
      if (!this.cache.has(p)) fetched.set(p, await api.getRows(s.query_id, p * PAGE, PAGE));
    }
    return rows.map((r) => {
      if (r >= s.row_count) return this.inserted[r - s.row_count] ?? [];
      const base = this.cache.peek(Math.floor(r / PAGE))?.[r % PAGE] ?? fetched.get(Math.floor(r / PAGE))?.[r % PAGE] ?? [];
      const e = this.edits.get(r);
      return e ? base.map((v, i) => e.get(i) ?? v) : base;
    });
  }
  get pendingCount() { return this.edits.size + this.deleted.size + this.inserted.length; }
  private total() { return (this.summary?.row_count ?? 0) + this.inserted.length; }

  /** Original (pre-edit) values of a loaded row, used to key UPDATE/DELETE by primary key. */
  original(r: number): Val[] | undefined {
    const n = this.summary?.row_count ?? 0;
    return r < n ? this.cache.peek(Math.floor(r / PAGE))?.[r % PAGE] : undefined;
  }
  /** The value currently shown in a cell (staged edit if any). */
  valueAt(r: number, c: number): Val | undefined {
    const n = this.summary?.row_count ?? 0;
    if (r >= n) return this.inserted[r - n]?.[c];
    return this.edits.get(r)?.get(c) ?? this.original(r)?.[c];
  }
  /** Stage a value for a cell exactly as the inline editor would. */
  stageEdit(r: number, c: number, v: Val) {
    if (!this.canEditCell(c) || this.deleted.has(r)) return;
    const n = this.summary!.row_count;
    if (r >= n) this.inserted[r - n][c] = v;
    else {
      const m = this.edits.get(r) ?? new Map<number, Val>();
      const orig = this.original(r)?.[c];
      if (orig && show(orig) === show(v) && (orig.t === "Null") === (v.t === "Null")) m.delete(c); else m.set(c, v);
      m.size ? this.edits.set(r, m) : this.edits.delete(r);
    }
    this.render();
    this.onChange();
  }
  columnName(c: number): string { return this.summary?.columns[c]?.name ?? ""; }
  editsOf(r: number) { return this.edits.get(r); }
  insertedRow(r: number) { return this.inserted[r - (this.summary?.row_count ?? 0)]; }

  addRow() {
    if (!this.summary) return;
    this.inserted.push(this.summary.columns.map(() => ({ t: "Null" }) as Val));
    this.rows = new Set([this.total() - 1]); this.anchor = this.total() - 1; this.allRows = false;
    this.resize();
    this.body.scrollTop = this.body.scrollHeight;
    this.onChange();
  }
  /** Is this a row that exists in the database (not a new, unsaved one)? */
  rowIsPersisted(r: number) { return r < (this.summary?.row_count ?? 0); }
  isMarkedDeleted(r: number) { return this.deleted.has(r); }
  /** Do the selected rows include any that still exist in the database and aren't marked yet? */
  get hasDeletableSelection() { return this.selectedRows().some((r) => this.rowIsPersisted(r) && !this.deleted.has(r)); }
  /** Stage deletion of every selected row; if they are all marked already, un-mark them. New unsaved rows are simply removed. */
  deleteSelected() {
    const n = this.summary?.row_count ?? 0;
    const picked = this.selectedRows();
    if (!picked.length) return;
    const saved = picked.filter((r) => r < n);
    const fresh = picked.filter((r) => r >= n);
    if (saved.length) {
      if (saved.every((r) => this.deleted.has(r))) saved.forEach((r) => this.deleted.delete(r));
      else saved.forEach((r) => this.deleted.add(r));
    }
    if (fresh.length) {
      for (const r of fresh.sort((a, b) => b - a)) this.inserted.splice(r - n, 1);
      this.rows = new Set(saved); this.anchor = saved[0] ?? -1; this.allRows = false;
      this.resize();
    }
    this.render();
    this.onChange();
    this.onSelect();
  }
  discard() {
    this.edits.clear(); this.deleted.clear(); this.inserted = [];
    this.resize(); this.render(); this.onChange();
  }
  private resize() { this.spacer.style.height = this.total() * ROW_H + "px"; }

  /** Edit a cell in place. `initial` (typing on a selected cell) replaces the content instead of editing it. */
  private startEdit(r: number, c: number, cell?: HTMLElement, initial?: string) {
    if (!this.canEditCell(c) || this.deleted.has(r)) return;
    this.reveal(r, c);
    this.render();
    cell ??= this.rowsLayer.querySelector<HTMLElement>(`[data-r="${r}"] > [data-c="${c}"]`) ?? undefined;
    if (!cell) return;
    const n = this.summary!.row_count;
    const cur = r >= n ? this.inserted[r - n][c] : this.edits.get(r)?.get(c) ?? this.original(r)?.[c];
    const input = document.createElement("input");
    input.className = "w-full h-full bg-panel text-ink outline outline-2 outline-accent px-1 mono";
    input.value = initial ?? (!cur || cur.t === "Null" ? "" : show(cur));
    input.placeholder = "NULL";
    cell.replaceChildren(input);
    input.focus();
    if (initial === undefined) input.select(); else input.setSelectionRange(input.value.length, input.value.length);
    let done = false;
    const finish = (save: boolean, step?: [number, number]) => {
      if (done) return; done = true;
      if (save) {
        const v: Val = input.value === "" || input.value === "NULL" ? { t: "Null" } : { t: "Text", v: input.value };
        if (r >= n) this.inserted[r - n][c] = v;
        else {
          const m = this.edits.get(r) ?? new Map<number, Val>();
          const orig = this.original(r)?.[c];
          if (orig && show(orig) === show(v) && (orig.t === "Null") === (v.t === "Null")) m.delete(c); else m.set(c, v);
          m.size ? this.edits.set(r, m) : this.edits.delete(r);
        }
        this.onChange();
      }
      this.render();
      if (step) { this.body.focus({ preventScroll: true }); this.move(...step); }
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true, [1, 0]);
      else if (e.key === "Escape") { finish(false); this.body.focus({ preventScroll: true }); }
      else if (e.key === "Tab") { e.preventDefault(); finish(true, [0, e.shiftKey ? -1 : 1]); }
    };
    input.onblur = () => finish(true);
  }

  /** The result on show. */
  get currentSummary() { return this.summary; }
  /** `release: false` keeps the previous result alive in Rust (the owner still lists it, e.g. run-all results). */
  async setResult(s: Summary | null, release = true) {
    if (this.summary && release) api.release(this.summary.query_id);
    this.edits.clear(); this.deleted.clear(); this.inserted = [];
    this.summary = s;
    this.cache.clear();
    this.loading.clear();
    this.rows = new Set(); this.anchor = -1; this.activeCol = -1; this.allRows = false;
    this.head.innerHTML = "";
    this.rowsLayer.innerHTML = "";
    this.body.scrollTop = 0;
    if (!s) return;
    this.widths = s.columns.map((c) => this.userWidths.get(c.name) ?? Math.max(MIN_W, WIDTH[kindOf(c.type_name)], Math.min(260, c.name.length * 8 + 70)));
    this.headCells = [];
    const corner = document.createElement("div");
    corner.className = "grid-cell gutter shrink-0";
    corner.style.height = "34px";
    corner.style.width = GUTTER + "px";
    this.head.append(corner);
    s.columns.forEach((c, i) => {
      const k = kindOf(c.type_name);
      const h = document.createElement("div");
      h.className = "grid-cell shrink-0 flex items-center gap-1.5 relative group";
      h.style.cssText = "height:34px;line-height:34px;font-weight:600;font-size:13px;color:var(--soft)";
      h.style.width = this.widths[i] + "px";
      h.style.justifyContent = k === "num" ? "flex-end" : "flex-start";
      const rank = this.sort.findIndex((x) => x.col === c.name);
      const key = rank >= 0 ? this.sort[rank] : null;
      if (key) h.style.color = "var(--ink)";
      h.title = `${c.name}  ${c.type_name}${this.sortable ? "\nClick to choose ascending / descending · Shift-click to add a second sort" : ""}`;
      h.innerHTML = `<span class="shrink-0" style="font-size:15px;line-height:1;font-weight:600;font-family:var(--font-mono);color:${GLYPH_COLOR[k]}">${GLYPH[k]}</span><span class="truncate"></span>` +
        (key ? `<span class="shrink-0 inline-flex items-center gap-0.5" style="color:var(--accent);font-size:11px"><svg width="13" height="13" viewBox="0 0 10 10" fill="currentColor" style="transform:rotate(${key.desc ? 180 : 0}deg)"><path d="M5 1.5 9 8H1z"/></svg>${this.sort.length > 1 ? rank + 1 : ""}</span>` : "");
      (h.children[1] as HTMLElement).textContent = c.name;
      if (this.sortable) {
        h.style.cursor = "pointer";
        h.onclick = (e) => this.onSort(c.name, e.shiftKey, e.clientX, e.clientY);
        h.oncontextmenu = (e) => { e.preventDefault(); this.onSort(c.name, false, e.clientX, e.clientY); };
        if (!key) h.onmouseenter = () => (h.style.background = "color-mix(in srgb, var(--accent) 7%, var(--grid-head))");
        if (!key) h.onmouseleave = () => (h.style.background = "");
      }
      // drag the right edge to resize; double-click it to fit the content
      const grip = document.createElement("span");
      grip.style.cssText = "position:absolute;right:-3px;top:0;bottom:0;width:7px;cursor:col-resize;z-index:2";
      grip.onclick = (e) => e.stopPropagation();
      grip.ondblclick = (e) => { e.stopPropagation(); this.fitColumn(i); };
      grip.onpointerdown = (e) => {
        e.preventDefault(); e.stopPropagation();
        const startX = e.clientX, startW = this.widths[i];
        grip.setPointerCapture(e.pointerId);
        grip.style.background = "var(--accent)";
        grip.onpointermove = (ev) => this.setWidth(i, Math.max(48, Math.min(900, startW + ev.clientX - startX)));
        grip.onpointerup = () => { grip.onpointermove = grip.onpointerup = null; grip.style.background = ""; };
      };
      h.append(grip);
      this.headCells.push(h);
      this.head.append(h);
    });
    const fill = document.createElement("div");
    fill.className = "flex-1";
    fill.style.minWidth = "0";
    this.head.append(fill);
    const total = this.widths.reduce((a, b) => a + b, 0) + GUTTER;
    this.resize();
    this.spacer.style.width = "100%"; this.spacer.style.minWidth = total + "px";
    this.rowsLayer.style.width = "100%"; this.rowsLayer.style.minWidth = total + "px";
    this.render();
  }

  private setWidth(i: number, w: number) {
    const name = this.summary?.columns[i]?.name;
    this.widths[i] = w;
    if (name) this.userWidths.set(name, w);
    if (this.headCells[i]) this.headCells[i].style.width = w + "px";
    const total = this.widths.reduce((a, b) => a + b, 0) + GUTTER;
    this.spacer.style.minWidth = total + "px";
    this.rowsLayer.style.minWidth = total + "px";
    this.render();
  }
  /** Fit a column to its content (header and the rows loaded so far). */
  private fitColumn(i: number) {
    const s = this.summary;
    if (!s) return;
    let chars = s.columns[i].name.length + 6;
    for (const page of this.cache.values()) for (const row of page) chars = Math.max(chars, show(row[i] ?? { t: "Null" }).length);
    this.setWidth(i, Math.max(64, Math.min(640, Math.round(chars * 7.6 + 28))));
  }

  private render() {
    const s = this.summary;
    if (!s || this.suspended) return;
    const first = Math.max(0, Math.floor(this.body.scrollTop / ROW_H) - 5);
    const last = Math.min(this.total(), Math.ceil((this.body.scrollTop + this.body.clientHeight) / ROW_H) + 5);
    for (let p = Math.floor(first / PAGE); p <= Math.floor(Math.max(first, last - 1) / PAGE); p++) this.cache.touch(p) || this.ensure(p);
    this.rowsLayer.style.top = first * ROW_H + "px";
    const frag = document.createDocumentFragment();
    for (let r = first; r < last; r++) {
      const isNew = r >= s.row_count;
      const row = isNew ? this.inserted[r - s.row_count] : this.cache.peek(Math.floor(r / PAGE))?.[r % PAGE];
      const div = document.createElement("div");
      const gone = this.deleted.has(r);
      const selected = this.isSelected(r);
      div.className = "flex " + (gone ? "line-through " : "");
      div.style.height = ROW_H + "px";
      div.style.background = gone ? "var(--del-soft)" : isNew ? "var(--new-soft)" : selected ? "var(--sel)" : r % 2 ? "var(--stripe)" : "";
      if (!gone && !isNew && !selected) { div.onmouseenter = () => (div.style.background = "var(--row-hover)"); div.onmouseleave = () => (div.style.background = r % 2 ? "var(--stripe)" : ""); }
      div.dataset.r = String(r);
      const g = document.createElement("div");
      g.className = "grid-cell gutter shrink-0";
      g.style.fontVariantNumeric = "tabular-nums";
      g.style.padding = "0 10px";
      g.style.width = GUTTER + "px";
      g.textContent = isNew ? "new" : String(r + 1);
      div.append(g);
      s.columns.forEach((col, i) => {
        const c = document.createElement("div");
        c.className = "grid-cell shrink-0";
        c.dataset.c = String(i);
        c.style.width = this.widths[i] + "px";
        if (r === this.anchor && i === this.activeCol && this.rows.size === 1 && !this.allRows) { c.style.outline = "2px solid var(--accent)"; c.style.outlineOffset = "-2px"; }
        const edited = this.edits.get(r)?.get(i);
        const v = edited ?? row?.[i];
        if (edited) { c.style.background = "var(--edit-soft)"; c.style.boxShadow = "inset 2px 0 0 var(--warn)"; }
        c.oncontextmenu = (e) => { e.preventDefault(); if (!this.isSelected(r)) this.pick(r, "single"); this.onCellMenu(e.clientX, e.clientY, r, i); };
        if (v) {
          const k = kindOf(col.type_name);
          if (v.t === "Null") c.innerHTML = '<span class="v-null">null</span>';
          else if (v.t === "Bool" || (k === "bool" && (v.t === "I64" || v.t === "Text"))) {
            const on = v.t === "Bool" ? v.v : v.v === 1 || v.v === "1" || v.v === "true";
            c.innerHTML = `<span style="color:${on ? "var(--ok)" : "var(--muted)"}">${on ? "●" : "○"} ${on ? "true" : "false"}</span>`;
          } else {
            c.textContent = show(v);
            if (k === "num" || v.t === "I64" || v.t === "F64") c.classList.add("v-num");
            else if (k === "time") c.classList.add("v-date");
            else if (k === "json") c.classList.add("v-soft");
            c.title = c.textContent ?? "";
          }
        }
        div.append(c);
      });
      frag.append(div);
    }
    this.rowsLayer.replaceChildren(frag);
  }

  private ensure(page: number) {
    if (this.cache.has(page) || this.loading.has(page) || !this.summary) return;
    const s = this.summary;
    this.loading.add(page);
    const p: Promise<void> = api.getRows(s.query_id, page * PAGE, PAGE).catch(() => []).then((rows) => {
      this.loading.delete(page);
      this.inflight.delete(p);
      if (this.summary !== s || this.suspended) return;
      this.cache.set(page, rows, this.pinnedPages());
      this.render();
    });
    this.inflight.add(p);
  }
  /** Tab went to the background: free the fetched rows and the row DOM (pages with staged edits stay, a commit needs them). */
  suspend() {
    if (this.suspended) return;
    this.suspended = true;
    const keep = this.pinnedPages();
    for (const p of [...this.cache.keys()]) if (!keep.has(p)) this.cache.drop(p);
    this.loading.clear();
    this.rowsLayer.replaceChildren();
  }
  /** Tab is on screen again: draw it, fetching the visible pages. */
  resume() {
    if (!this.suspended) return;
    this.suspended = false;
    this.render();
  }
  /** Pages holding staged edits or deletes: a commit needs their original rows, so they are never evicted. */
  private pinnedPages() {
    const pinned = new Set<number>();
    for (const r of this.edits.keys()) pinned.add(Math.floor(r / PAGE));
    for (const r of this.deleted) pinned.add(Math.floor(r / PAGE));
    return pinned;
  }
  /** Resolves once every page requested so far has arrived (used by the memory profiler). */
  async idle() { while (this.inflight.size) await Promise.all([...this.inflight]); }
  /** Number of result pages currently held in memory. */
  get cachedPages() { return this.cache.size; }
}
