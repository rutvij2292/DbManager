import { api, show, type Summary, type Val } from "./api";
import type { SortKey } from "./builder-sql";

const ROW_H = 30, PAGE = 200, MIN_W = 80, GUTTER = 52;

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
  private cache = new Map<number, Val[][]>();
  private loading = new Set<number>();
  private widths: number[] = [];
  private sel = -1;
  private summary: Summary | null = null;

  // Row editing (table tabs): staged client-side until committed.
  editable = false;
  onChange: () => void = () => {};
  /** Header click-to-sort; set `sortable` to show the affordance. `additive` = shift-click. */
  sortable = false;
  sort: SortKey[] = [];
  onSort: (col: string, additive: boolean) => void = () => {};
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
  }

  get columns() { return this.summary?.columns ?? []; }
  get selected() { return this.sel; }
  get pendingCount() { return this.edits.size + this.deleted.size + this.inserted.length; }
  private total() { return (this.summary?.row_count ?? 0) + this.inserted.length; }

  /** Original (pre-edit) values of a loaded row, used to key UPDATE/DELETE by primary key. */
  original(r: number): Val[] | undefined {
    const n = this.summary?.row_count ?? 0;
    return r < n ? this.cache.get(Math.floor(r / PAGE))?.[r % PAGE] : undefined;
  }
  /** The value currently shown in a cell (staged edit if any). */
  valueAt(r: number, c: number): Val | undefined {
    const n = this.summary?.row_count ?? 0;
    if (r >= n) return this.inserted[r - n]?.[c];
    return this.edits.get(r)?.get(c) ?? this.original(r)?.[c];
  }
  /** Stage a value for a cell exactly as the inline editor would. */
  stageEdit(r: number, c: number, v: Val) {
    if (!this.editable || this.deleted.has(r)) return;
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
    this.sel = this.total() - 1;
    this.resize();
    this.body.scrollTop = this.body.scrollHeight;
    this.onChange();
  }
  deleteSelected() {
    const n = this.summary?.row_count ?? 0;
    if (this.sel < 0) return;
    if (this.sel >= n) this.inserted.splice(this.sel - n, 1), (this.sel = -1), this.resize();
    else this.deleted.has(this.sel) ? this.deleted.delete(this.sel) : this.deleted.add(this.sel);
    this.render();
    this.onChange();
  }
  discard() {
    this.edits.clear(); this.deleted.clear(); this.inserted = [];
    this.resize(); this.render(); this.onChange();
  }
  private resize() { this.spacer.style.height = this.total() * ROW_H + "px"; }

  private startEdit(r: number, c: number, cell: HTMLElement) {
    if (!this.editable || this.deleted.has(r)) return;
    const n = this.summary!.row_count;
    const cur = r >= n ? this.inserted[r - n][c] : this.edits.get(r)?.get(c) ?? this.original(r)?.[c];
    const input = document.createElement("input");
    input.className = "w-full h-full bg-panel text-ink outline outline-2 outline-accent px-1 mono";
    input.value = !cur || cur.t === "Null" ? "" : show(cur);
    input.placeholder = "NULL";
    cell.replaceChildren(input);
    input.focus(); input.select();
    let done = false;
    const finish = (save: boolean) => {
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
    };
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); else if (e.key === "Tab") { e.preventDefault(); finish(true); } };
    input.onblur = () => finish(true);
  }

  async setResult(s: Summary | null) {
    if (this.summary) api.release(this.summary.query_id);
    this.edits.clear(); this.deleted.clear(); this.inserted = [];
    this.summary = s;
    this.cache.clear();
    this.loading.clear();
    this.sel = -1;
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
      h.title = `${c.name}  ${c.type_name}${this.sortable ? "\nClick to sort · Shift-click to add a second sort" : ""}`;
      h.innerHTML = `<span style="font-size:11px;font-weight:500;font-family:var(--font-mono);color:${GLYPH_COLOR[k]}">${GLYPH[k]}</span><span class="truncate"></span>` +
        (key ? `<span class="shrink-0 inline-flex items-center gap-0.5" style="color:var(--accent);font-size:11px"><svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style="transform:rotate(${key.desc ? 180 : 0}deg)"><path d="M5 1.5 9 8H1z"/></svg>${this.sort.length > 1 ? rank + 1 : ""}</span>` : "");
      (h.children[1] as HTMLElement).textContent = c.name;
      if (this.sortable) {
        h.style.cursor = "pointer";
        h.onclick = (e) => this.onSort(c.name, e.shiftKey);
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
    if (!s) return;
    const first = Math.max(0, Math.floor(this.body.scrollTop / ROW_H) - 5);
    const last = Math.min(this.total(), Math.ceil((this.body.scrollTop + this.body.clientHeight) / ROW_H) + 5);
    for (let p = Math.floor(first / PAGE); p <= Math.floor(Math.max(first, last - 1) / PAGE); p++) this.ensure(p);
    this.rowsLayer.style.top = first * ROW_H + "px";
    const frag = document.createDocumentFragment();
    for (let r = first; r < last; r++) {
      const isNew = r >= s.row_count;
      const row = isNew ? this.inserted[r - s.row_count] : this.cache.get(Math.floor(r / PAGE))?.[r % PAGE];
      const div = document.createElement("div");
      const gone = this.deleted.has(r);
      const selected = r === this.sel;
      div.className = "flex " + (gone ? "line-through " : "");
      div.style.height = ROW_H + "px";
      div.style.background = gone ? "var(--del-soft)" : isNew ? "var(--new-soft)" : selected ? "var(--sel)" : r % 2 ? "var(--stripe)" : "";
      if (!gone && !isNew && !selected) { div.onmouseenter = () => (div.style.background = "var(--row-hover)"); div.onmouseleave = () => (div.style.background = r % 2 ? "var(--stripe)" : ""); }
      div.onclick = () => { this.sel = r; this.render(); };
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
        c.style.width = this.widths[i] + "px";
        const edited = this.edits.get(r)?.get(i);
        const v = edited ?? row?.[i];
        if (edited) { c.style.background = "var(--edit-soft)"; c.style.boxShadow = "inset 2px 0 0 var(--warn)"; }
        c.ondblclick = () => this.startEdit(r, i, c);
        c.oncontextmenu = (e) => { e.preventDefault(); this.sel = r; this.render(); this.onCellMenu(e.clientX, e.clientY, r, i); };
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

  private async ensure(page: number) {
    if (this.cache.has(page) || this.loading.has(page) || !this.summary) return;
    const s = this.summary;
    this.loading.add(page);
    const rows = await api.getRows(s.query_id, page * PAGE, PAGE).catch(() => []);
    this.loading.delete(page);
    if (this.summary !== s) return;
    this.cache.set(page, rows);
    this.render();
  }
}
