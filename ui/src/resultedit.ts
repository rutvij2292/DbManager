/** Decide whether a query result can be edited in place: a plain `SELECT` over exactly one table, with the primary key in the result. */

export interface Source { schema: string | null; table: string; items: Item[] }
/** One entry of the select list: `*` (all columns of the table) or a single expression, `col` being the table column it is when it is just a column. */
export type Item = { star: true } | { star?: false; col: string | null };
export type Analysis = ({ ok: true } & Source) | { ok: false; reason: string };

interface Tok { k: "id" | "qid" | "str" | "num" | "p"; v: string }

function tokenize(sql: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (/\s/.test(c)) i++;
    else if (c === "-" && n === "-") { while (i < sql.length && sql[i] !== "\n") i++; }
    else if (c === "/" && n === "*") { const e = sql.indexOf("*/", i + 2); if (e < 0) return null; i = e + 2; }
    else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1, v = "";
      for (; j < sql.length; j++) {
        if (sql[j] === "\\" && c === "'") { v += sql[j + 1] ?? ""; j++; continue; }
        if (sql[j] === close) { if (sql[j + 1] === close) { v += close; j++; continue; } break; }
        v += sql[j];
      }
      if (j >= sql.length) return null;
      out.push({ k: c === "'" ? "str" : "qid", v });
      i = j + 1;
    } else if (/[A-Za-z_\u0080-￿]/.test(c) || c === "$" || c === "#" || c === "@") {
      let j = i + 1;
      while (j < sql.length && /[\w$#@\u0080-￿]/.test(sql[j])) j++;
      out.push({ k: "id", v: sql.slice(i, j) });
      i = j;
    } else if (/\d/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[\w.]/.test(sql[j])) j++;
      out.push({ k: "num", v: sql.slice(i, j) });
      i = j;
    } else { out.push({ k: "p", v: c }); i++; }
  }
  return out;
}

const kw = (t: Tok | undefined, ...words: string[]) => !!t && t.k === "id" && words.includes(t.v.toLowerCase());
const AGGREGATES = new Set(["count", "sum", "avg", "min", "max", "group_concat", "string_agg", "array_agg", "json_agg", "jsonb_agg", "listagg", "stddev", "variance", "total"]);
/** Words that may follow the table name; anything else there is taken as an alias. */
const TAIL = ["where", "order", "limit", "offset", "fetch"];
const BAD_ANYWHERE: Record<string, string> = {
  join: "joins", straight_join: "joins", union: "UNION", intersect: "INTERSECT", except: "EXCEPT", group: "GROUP BY", having: "HAVING", into: "INTO", window: "WINDOW",
};

/** Parse `sql` and report the one table it reads from, or why it can't be edited. */
export function analyzeSelect(sql: string): Analysis {
  const no = (reason: string): Analysis => ({ ok: false, reason });
  const all = tokenize(sql);
  if (!all) return no("couldn't read the query");
  const toks = all.slice();
  while (toks.length && toks[toks.length - 1].k === "p" && toks[toks.length - 1].v === ";") toks.pop();
  if (toks.some((t) => t.k === "p" && t.v === ";")) return no("it has more than one statement");
  if (!kw(toks[0], "select")) return no("only a plain SELECT can be edited");

  // Split at depth 0 into the select list and the rest; reject constructs that break the one-row-one-table rule.
  let depth = 0, from = -1;
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === "p" && t.v === "(") depth++;
    else if (t.k === "p" && t.v === ")") depth--;
    else if (depth === 0 && t.k === "id") {
      const w = t.v.toLowerCase();
      if (w === "from" && from < 0) from = i;
      else if (BAD_ANYWHERE[w]) return no(`it uses ${BAD_ANYWHERE[w]}`);
    }
  }
  if (from < 0) return no("it has no FROM clause");

  // Select list.
  let s = 1;
  if (kw(toks[s], "distinct", "distinctrow", "unique")) return no("it uses DISTINCT");
  if (kw(toks[s], "all")) s++;
  if (kw(toks[s], "top")) { s++; if (toks[s]?.k === "p" && toks[s].v === "(") { while (s < from && !(toks[s].k === "p" && toks[s].v === ")")) s++; s++; } else s++; if (kw(toks[s], "percent")) return no("it uses TOP PERCENT"); }
  const parts: Tok[][] = [[]];
  depth = 0;
  for (let i = s; i < from; i++) {
    const t = toks[i];
    if (t.k === "p" && t.v === "(") depth++;
    else if (t.k === "p" && t.v === ")") depth--;
    if (depth === 0 && t.k === "p" && t.v === ",") parts.push([]); else parts[parts.length - 1].push(t);
  }
  if (parts.some((p) => !p.length)) return no("couldn't read the select list");

  // FROM clause: exactly [schema.]table [[AS] alias], then an optional WHERE / ORDER BY / LIMIT tail.
  let f = from + 1;
  const name = (t?: Tok) => (t && (t.k === "id" || t.k === "qid") ? t.v : null);
  let table = name(toks[f]);
  if (!table || toks[f].k === "str") return no("it doesn't read from a plain table");
  let schema: string | null = null;
  f++;
  if (toks[f]?.k === "p" && toks[f].v === ".") {
    const t2 = name(toks[f + 1]);
    if (!t2) return no("it doesn't read from a plain table");
    schema = table; table = t2; f += 2;
    if (toks[f]?.k === "p" && toks[f].v === ".") { const t3 = name(toks[f + 1]); if (!t3) return no("it doesn't read from a plain table"); schema = table; table = t3; f += 2; }
  }
  if (toks[f]?.k === "p" && toks[f].v === ",") return no("it reads from more than one table");
  if (toks[f]?.k === "p" && toks[f].v === "(") return no("it doesn't read from a plain table");
  let alias: string | null = null;
  if (kw(toks[f], "as")) { alias = name(toks[f + 1]); if (!alias) return no("couldn't read the table alias"); f += 2; }
  else if (toks[f] && (toks[f].k === "qid" || (toks[f].k === "id" && !TAIL.includes(toks[f].v.toLowerCase()) && !kw(toks[f], "for", "using", "on", "set")))) { alias = toks[f].v; f++; }
  if (f < toks.length) {
    if (toks[f].k === "p" && toks[f].v === ",") return no("it reads from more than one table");
    if (!kw(toks[f], ...TAIL)) return no("it uses a clause that can't be edited");
  }
  const same = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const mine = (q: string) => same(q, alias ?? table);

  const items: Item[] = [];
  for (const p of parts) {
    // An aggregate collapses rows: nothing in the result maps to one row.
    const agg = p.find((t, i) => t.k === "id" && AGGREGATES.has(t.v.toLowerCase()) && p[i + 1]?.v === "(");
    if (agg) return no(`it uses ${agg.v.toUpperCase()}()`);
    if (p.length === 1 && p[0].k === "p" && p[0].v === "*") { items.push({ star: true }); continue; }
    if (p.length === 3 && name(p[0]) && p[1].v === "." && p[2].k === "p" && p[2].v === "*") {
      if (!mine(p[0].v)) return no(`"${p[0].v}.*" isn't this table`);
      items.push({ star: true }); continue;
    }
    // [qualifier.]column [[AS] alias]
    let i = 0, qual: string | null = null;
    let col = name(p[i]);
    if (!col || p[0].k === "num" || p[0].k === "str") { items.push({ col: null }); continue; }
    i++;
    if (p[i]?.k === "p" && p[i].v === ".") {
      const c2 = name(p[i + 1]);
      if (!c2) { items.push({ col: null }); continue; }
      qual = col; col = c2; i += 2;
      if (p[i]?.k === "p" && p[i].v === ".") {
        // schema.table.column
        const c3 = name(p[i + 1]);
        if (!c3) { items.push({ col: null }); continue; }
        qual = col; col = c3; i += 2;
      }
    }
    let rest = p.slice(i);
    if (kw(rest[0], "as")) rest = rest.slice(1);
    // What is left must be a bare alias (or nothing), otherwise this is an expression (CASE, a || b, a + 1, a::int ...).
    const isCol = rest.length === 0 || (rest.length === 1 && (rest[0].k === "id" || rest[0].k === "qid" || rest[0].k === "str") && !kw(rest[0], "is", "in", "and", "or", "not", "like", "between", "collate", "over", "end"));
    if (!isCol) { items.push({ col: null }); continue; }
    if (qual && !mine(qual)) return no(`"${qual}" isn't this table`);
    items.push({ col });
  }
  return { ok: true, schema, table, items };
}

export interface ColumnLike { name: string; primary_key: boolean }
export type Resolved = { ok: true; table: string; schema: string | null; cols: ColumnLike[]; /** per result column: the real table column it edits, or null */ map: (string | null)[] } | { ok: false; reason: string };

/** Match the result's columns (`result`, in order) with the table's columns. Editable only if every primary-key column is present. */
export function resolveEdit(a: Source, result: string[], tableCols: ColumnLike[]): Resolved {
  const find = (n: string) => tableCols.find((c) => c.name === n) ?? tableCols.find((c) => c.name.toLowerCase() === n.toLowerCase());
  const map: (string | null)[] = [];
  for (const it of a.items) {
    if (it.star) tableCols.forEach((c) => map.push(c.name));
    else map.push(it.col ? find(it.col)?.name ?? null : null);
  }
  if (map.length !== result.length) return { ok: false, reason: "the result's columns don't match the table's" };
  const seen = new Set<string>();
  map.forEach((m, i) => { if (m && seen.has(m)) map[i] = null; else if (m) seen.add(m); });
  const pk = tableCols.filter((c) => c.primary_key);
  if (!pk.length) return { ok: false, reason: `${a.table} has no primary key` };
  const missing = pk.filter((c) => !seen.has(c.name));
  if (missing.length) return { ok: false, reason: `the result doesn't include the primary key (${missing.map((c) => c.name).join(", ")})` };
  return { ok: true, table: a.table, schema: a.schema, cols: tableCols, map };
}
