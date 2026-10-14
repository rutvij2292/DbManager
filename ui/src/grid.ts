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

  async setResult(s: Summary | null) {
    if (this.summary) api.release(this.summary.query_id);
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
    this.spacer.style.height = s.row_count * ROW_H + "px";
    this.spacer.style.width = total + "px";
    this.rowsLayer.style.width = total + "px";
    this.render();
  }

  private render() {
    const s = this.summary;
    if (!s) return;
    const first = Math.max(0, Math.floor(this.body.scrollTop / ROW_H) - 5);
    const last = Math.min(s.row_count, Math.ceil((this.body.scrollTop + this.body.clientHeight) / ROW_H) + 5);
    for (let p = Math.floor(first / PAGE); p <= Math.floor(Math.max(first, last - 1) / PAGE); p++) this.ensure(p);
    this.rowsLayer.style.top = first * ROW_H + "px";
    const frag = document.createDocumentFragment();
    for (let r = first; r < last; r++) {
      const row = this.cache.get(Math.floor(r / PAGE))?.[r % PAGE];
      const div = document.createElement("div");
      div.className = "flex hover:bg-zinc-800 " + (r === this.sel ? "bg-blue-900/50" : r % 2 ? "bg-zinc-900" : "bg-zinc-900/60");
      div.onclick = () => { this.sel = r; this.render(); };
      s.columns.forEach((_, i) => {
        const c = document.createElement("div");
        c.className = "grid-cell shrink-0";
        c.style.width = this.widths[i] + "px";
        const v = row?.[i];
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
