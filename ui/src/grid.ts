import { api, show, type Summary, type Val } from "./api";

const ROW_H = 24, PAGE = 200, MIN_W = 80;

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
  edits = new Map<number, Map<number, Val>>();
  deleted = new Set<number>();
  inserted: Val[][] = [];

  constructor() {
    this.el.className = "h-full flex flex-col mono text-[12px] bg-zinc-900";
    this.head.className = "flex bg-zinc-800 border-b border-zinc-700 overflow-hidden shrink-0";
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
    input.className = "w-full h-full bg-zinc-950 text-zinc-100 outline outline-1 outline-blue-500 px-1 mono";
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
    this.widths = s.columns.map((c) => Math.max(MIN_W, Math.min(280, c.name.length * 9 + 24)));
    s.columns.forEach((c, i) => {
      const h = document.createElement("div");
      h.className = "grid-cell font-semibold text-zinc-300 shrink-0";
      h.style.width = this.widths[i] + "px";
      h.textContent = c.name;
      h.title = `${c.name} ${c.type_name}`;
      this.head.append(h);
    });
    const total = this.widths.reduce((a, b) => a + b, 0);
    this.resize();
    this.spacer.style.width = total + "px";
    this.rowsLayer.style.width = total + "px";
    this.render();
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
      div.className = "flex hover:bg-zinc-800 " + (gone ? "bg-red-950/60 line-through text-zinc-500 " : isNew ? "bg-green-950/50 " : "") + (r === this.sel ? "outline outline-1 -outline-offset-1 outline-blue-500 " : r % 2 ? "bg-zinc-900" : "bg-zinc-900/60");
      div.onclick = () => { this.sel = r; this.render(); };
      s.columns.forEach((_, i) => {
        const c = document.createElement("div");
        c.className = "grid-cell shrink-0";
        c.style.width = this.widths[i] + "px";
        const edited = this.edits.get(r)?.get(i);
        const v = edited ?? row?.[i];
        if (edited) c.classList.add("bg-amber-900/50");
        c.ondblclick = () => this.startEdit(r, i, c);
        if (v) {
          c.textContent = show(v);
          if (v.t === "Null") c.classList.add("null");
          else if (v.t === "I64" || v.t === "F64") c.style.textAlign = "right";
          c.title = c.textContent;
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
