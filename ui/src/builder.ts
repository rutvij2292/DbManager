import type { SchemaTable } from "./api";
import { buildSql, emptyModel, suggestJoin, OPS, type Agg, type JoinType, type Model, type Quote, type Ref } from "./builder-sql";

const sel = "bg-panel border border-line-strong rounded px-1 py-0.5 outline-none focus:border-accent";
const key = (t: { table: string; schema: string | null }) => `${t.schema ?? ""}.${t.table}`;
const tkey = (t: SchemaTable) => `${t.schema ?? ""}.${t.name}`;

/**
 * Visual query builder panel. Pick tables, columns, filters and ordering; every change
 * regenerates the SQL and hands it to `onSql` (the tab's editor).
 */
export function createBuilder(getTables: () => SchemaTable[], quote: () => Quote, onSql: (sql: string) => void, top: () => boolean = () => false): HTMLElement {
  const root = document.createElement("div");
  root.className = "h-full overflow-auto p-2 text-[12px] bg-canvas border-b border-line-strong";
  let m: Model = emptyModel();

  const tables = () => getTables();
  const find = (k: string) => tables().find((t) => tkey(t) === k);
  const used = (): SchemaTable[] =>
    m.from ? [m.from, ...m.joins].map((t) => find(key(t))).filter((t): t is SchemaTable => !!t) : [];
  const refOf = (t: SchemaTable, c: string): Ref => ({ table: t.name, schema: t.schema, col: c });
  const refKey = (r: Ref) => `${r.schema ?? ""}.${r.table}.${r.col}`;
  const allRefs = () => used().flatMap((t) => t.columns.map((c) => refOf(t, c)));
  const refFromKey = (k: string) => allRefs().find((r) => refKey(r) === k)!;

  const emit = () => onSql(buildSql(m, quote(), top()));
  const change = () => { emit(); draw(); };

  function select(options: [string, string][], value: string, on: (v: string) => void, cls = sel) {
    const s = document.createElement("select");
    s.className = cls;
    for (const [v, label] of options) {
      const o = document.createElement("option");
      o.value = v; o.textContent = label; o.selected = v === value;
      s.append(o);
    }
    s.onchange = () => on(s.value);
    return s;
  }
  function button(label: string, on: () => void, cls = "") {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "px-2 py-0.5 rounded bg-raised hover:bg-raised2 " + cls;
    b.onclick = on;
    return b;
  }
  const section = (title: string, ...kids: (HTMLElement | string)[]) => {
    const d = document.createElement("div");
    d.className = "mb-2";
    const h = document.createElement("div");
    h.className = "text-[10px] uppercase tracking-wide text-muted mb-1";
    h.textContent = title;
    d.append(h, ...kids);
    return d;
  };
  const row = (...kids: HTMLElement[]) => {
    const d = document.createElement("div");
    d.className = "flex gap-1 items-center mb-1 flex-wrap";
    d.append(...kids);
    return d;
  };
  const colOptions = (): [string, string][] => allRefs().map((r) => [refKey(r), `${r.table}.${r.col}`]);

  function draw() {
    const top = document.createElement("div");
    const tableOpts: [string, string][] = [["", "Choose table…"], ...tables().map((t): [string, string] => [tkey(t), (t.schema && t.schema !== "public" ? t.schema + "." : "") + t.name])];

    // FROM + JOINs
    const fromBox = section("From");
    fromBox.append(row(select(tableOpts, m.from ? key(m.from) : "", (v) => {
      const t = find(v);
      m = { ...emptyModel(), from: t ? { table: t.name, schema: t.schema } : null };
      change();
    })));
    m.joins.forEach((j, i) => {
      const opts = colOptions();
      fromBox.append(row(
        select([["INNER", "INNER JOIN"], ["LEFT", "LEFT JOIN"], ["RIGHT", "RIGHT JOIN"]], j.type, (v) => { j.type = v as JoinType; change(); }),
        select(tableOpts.slice(1), key(j), (v) => { const t = find(v)!; j.table = t.name; j.schema = t.schema; change(); }),
        document.createTextNode("on") as unknown as HTMLElement,
        select(opts, refKey(j.left), (v) => { j.left = refFromKey(v); change(); }),
        document.createTextNode("=") as unknown as HTMLElement,
        select(opts, refKey(j.right), (v) => { j.right = refFromKey(v); change(); }),
        button("×", () => { m.joins.splice(i, 1); change(); }),
      ));
    });
    if (m.from) {
      fromBox.append(row(select([["", "+ Join table…"], ...tableOpts.slice(1)], "", (v) => {
        const next = find(v);
        if (!next) return;
        const guess = suggestJoin(used(), next);
        const first = used()[0];
        m.joins.push({
          type: "INNER", table: next.name, schema: next.schema,
          left: guess?.left ?? refOf(first, first.columns[0]),
          right: guess?.right ?? refOf(next, next.columns[0]),
        });
        change();
      })));
    }

    // Columns
    const colBox = section("Columns");
    if (m.from) {
      const grid = document.createElement("div");
      grid.className = "flex flex-wrap gap-x-4 gap-y-1";
      for (const t of used()) {
        const g = document.createElement("div");
        g.className = "min-w-40";
        g.innerHTML = `<div class="text-soft font-semibold">${t.name.replace(/</g, "&lt;")}</div>`;
        for (const c of t.columns) {
          const r = refOf(t, c);
          const existing = m.cols.find((x) => refKey(x.ref) === refKey(r));
          const line = document.createElement("label");
          line.className = "flex items-center gap-1";
          const cb = document.createElement("input");
          cb.type = "checkbox"; cb.checked = !!existing;
          cb.onchange = () => {
            if (cb.checked) m.cols.push({ ref: r, agg: "" }); else m.cols = m.cols.filter((x) => refKey(x.ref) !== refKey(r));
            change();
          };
          line.append(cb, document.createTextNode(c));
          if (existing) {
            line.append(select([["", "—"], ...(["COUNT", "SUM", "AVG", "MIN", "MAX"] as const).map((a): [string, string] => [a, a])], existing.agg, (v) => { existing.agg = v as Agg; change(); }, sel + " text-[11px]"));
          }
          g.append(line);
        }
        grid.append(g);
      }
      colBox.append(grid);
      const opts = document.createElement("div");
      opts.className = "flex gap-4 mt-1";
      const check = (label: string, get: () => boolean, set: (v: boolean) => void) => {
        const l = document.createElement("label");
        l.className = "flex items-center gap-1";
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = get(); cb.onchange = () => { set(cb.checked); change(); };
        l.append(cb, document.createTextNode(label));
        return l;
      };
      opts.append(check("DISTINCT", () => m.distinct, (v) => (m.distinct = v)), check("COUNT(*)", () => m.countAll, (v) => (m.countAll = v)));
      colBox.append(opts);
    } else colBox.append("Choose a table first.");

    // Filters
    const filterBox = section("Filters");
    if (m.from) {
      m.filters.forEach((f, i) => {
        const val = document.createElement("input");
        val.className = sel + " w-40";
        val.value = f.value;
        val.placeholder = f.op === "IN" ? "a, b, c" : "value";
        val.disabled = f.op === "IS NULL" || f.op === "IS NOT NULL";
        val.oninput = () => { f.value = val.value; emit(); };
        filterBox.append(row(
          ...(i ? [select([["and", "AND"], ["or", "OR"]], f.or ? "or" : "and", (v) => { f.or = v === "or"; change(); }, sel + " w-16")] : []),
          select(colOptions(), refKey(f.ref), (v) => { f.ref = refFromKey(v); change(); }),
          select(OPS.map((o): [string, string] => [o, o]), f.op, (v) => { f.op = v as typeof f.op; change(); }),
          val,
          button("×", () => { m.filters.splice(i, 1); change(); }),
        ));
      });
      filterBox.append(row(button("+ Filter", () => { m.filters.push({ ref: allRefs()[0], op: "=", value: "" }); change(); })));
    }

    // Order + limit
    const orderBox = section("Order & limit");
    if (m.from) {
      m.orderBy.forEach((o, i) => orderBox.append(row(
        select(colOptions(), refKey(o.ref), (v) => { o.ref = refFromKey(v); change(); }),
        select([["ASC", "ASC"], ["DESC", "DESC"]], o.dir, (v) => { o.dir = v as "ASC" | "DESC"; change(); }),
        button("×", () => { m.orderBy.splice(i, 1); change(); }),
      )));
      const lim = document.createElement("input");
      lim.type = "number"; lim.min = "0"; lim.className = sel + " w-20"; lim.value = m.limit ? String(m.limit) : ""; lim.placeholder = "none";
      lim.oninput = () => { m.limit = lim.value ? Math.max(0, +lim.value) || null : null; emit(); };
      const l = document.createElement("span");
      l.textContent = "Limit";
      orderBox.append(row(button("+ Order by", () => { m.orderBy.push({ ref: allRefs()[0], dir: "ASC" }); change(); }), l, lim, button("Reset", () => { m = emptyModel(); change(); }, "ml-auto")));
    }

    top.className = "grid gap-x-6 grid-cols-[minmax(260px,1fr)_minmax(260px,1.2fr)]";
    const left = document.createElement("div"), right = document.createElement("div");
    left.append(fromBox, colBox);
    right.append(filterBox, orderBox);
    top.append(left, right);
    root.replaceChildren(top);
  }

  draw();
  // Expose a redraw so the owner can refresh when the schema finishes loading.
  (root as HTMLElement & { refresh?: () => void }).refresh = draw;
  return root;
}
