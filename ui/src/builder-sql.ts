import type { SchemaTable } from "./api";

/** Visual query builder model and SQL generation (pure, no DOM). */
export type Agg = "" | "COUNT" | "SUM" | "AVG" | "MIN" | "MAX";
export type JoinType = "INNER" | "LEFT" | "RIGHT";
export const OPS = ["=", "<>", "<", ">", "<=", ">=", "LIKE", "NOT LIKE", "IN", "IS NULL", "IS NOT NULL"] as const;

export interface Ref { table: string; schema: string | null; col: string }
export interface SelCol { ref: Ref; agg: Agg }
export interface JoinDef { type: JoinType; table: string; schema: string | null; left: Ref; right: Ref }
export interface Filter { ref: Ref; op: (typeof OPS)[number]; value: string; or?: boolean }
export interface OrderBy { ref: Ref; dir: "ASC" | "DESC" }
export interface Model {
  from: { table: string; schema: string | null } | null;
  joins: JoinDef[];
  cols: SelCol[];
  countAll: boolean;
  distinct: boolean;
  filters: Filter[];
  orderBy: OrderBy[];
  limit: number | null;
}
export const emptyModel = (): Model => ({ from: null, joins: [], cols: [], countAll: false, distinct: false, filters: [], orderBy: [], limit: 100 });

export type Quote = (ident: string) => string;

const tbl = (q: Quote, t: { table: string; schema: string | null }) => (t.schema && t.schema !== "public" ? `${q(t.schema)}.${q(t.table)}` : q(t.table));
const col = (q: Quote, r: Ref) => `${q(r.table)}.${q(r.col)}`;

export function literal(v: string): string {
  const t = v.trim();
  return t !== "" && /^-?\d+(\.\d+)?$/.test(t) ? t : `'${v.replace(/'/g, "''")}'`;
}

/** `top` = T-SQL style (`SELECT TOP n`) instead of a trailing LIMIT. */
export function buildSql(m: Model, q: Quote, top = false): string {
  if (!m.from) return "";
  const aggs = m.cols.some((c) => c.agg) || m.countAll;
  const select: string[] = m.cols.map((c) => (c.agg ? `${c.agg}(${col(q, c.ref)}) AS ${q(`${c.agg.toLowerCase()}_${c.ref.col}`)}` : col(q, c.ref)));
  if (m.countAll) select.push("COUNT(*) AS " + q("count"));
  const lines = [`SELECT ${m.distinct ? "DISTINCT " : ""}${top && m.limit ? `TOP ${m.limit} ` : ""}${select.length ? select.join(", ") : "*"}`, `FROM ${tbl(q, m.from)}`];
  for (const j of m.joins) lines.push(`${j.type} JOIN ${tbl(q, j)} ON ${col(q, j.left)} = ${col(q, j.right)}`);
  const where = m.filters
    .map((f) => {
      const c = col(q, f.ref);
      if (f.op === "IS NULL" || f.op === "IS NOT NULL") return `${c} ${f.op}`;
      if (f.op === "IN") {
        const items = f.value.split(",").map((s) => s.trim()).filter(Boolean);
        return items.length ? `${c} IN (${items.map(literal).join(", ")})` : "";
      }
      return f.value === "" ? "" : `${c} ${f.op} ${literal(f.value)}`;
    });
  const parts: string[] = [];
  m.filters.forEach((f, i) => {
    if (!where[i]) return;
    parts.push(parts.length ? `${f.or ? "OR" : "AND"} ${where[i]}` : where[i]);
  });
  if (parts.length) lines.push("WHERE " + parts.join("\n  "));
  const plain = m.cols.filter((c) => !c.agg);
  if (aggs && plain.length) lines.push("GROUP BY " + plain.map((c) => col(q, c.ref)).join(", "));
  if (m.orderBy.length) lines.push("ORDER BY " + m.orderBy.map((o) => `${col(q, o.ref)} ${o.dir}`).join(", "));
  if (m.limit && !top) lines.push(`LIMIT ${m.limit}`);
  return lines.join("\n") + ";";
}

/** Guess the ON columns for joining `next` to one of the tables already in the query. */
export function suggestJoin(existing: SchemaTable[], next: SchemaTable): { left: Ref; right: Ref } | null {
  const lc = (s: string) => s.toLowerCase();
  const singular = (s: string) => lc(s).replace(/ies$/, "y").replace(/s$/, "");
  const ref = (t: SchemaTable, c: string): Ref => ({ table: t.name, schema: t.schema, col: c });
  for (const prev of existing) {
    // next.<prev>_id -> prev.id
    const fk = next.columns.find((c) => lc(c) === `${singular(prev.name)}_id` || lc(c) === `${lc(prev.name)}_id`);
    const pk = prev.columns.find((c) => lc(c) === "id");
    if (fk && pk) return { left: ref(prev, pk), right: ref(next, fk) };
    // prev.<next>_id -> next.id
    const fk2 = prev.columns.find((c) => lc(c) === `${singular(next.name)}_id` || lc(c) === `${lc(next.name)}_id`);
    const pk2 = next.columns.find((c) => lc(c) === "id");
    if (fk2 && pk2) return { left: ref(prev, fk2), right: ref(next, pk2) };
    const same = prev.columns.find((c) => next.columns.some((n) => lc(n) === lc(c)) && lc(c) !== "id" && lc(c) !== "created_at" && lc(c) !== "updated_at");
    if (same) return { left: ref(prev, same), right: ref(next, next.columns.find((n) => lc(n) === lc(same))!) };
  }
  return null;
}

/** Row filter rules for the table view (column / operator / value). */
export const FILTER_OPS = ["=", "<>", "<", ">", "<=", ">=", "contains", "begins with", "ends with", "in list", "is null", "is not null"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export interface FilterRule { col: string; op: FilterOp; value: string; or?: boolean }

const str = (v: string) => `'${v.replace(/'/g, "''")}'`;
// `!` is the LIKE escape: unlike backslash it means the same thing in every dialect's string literals.
const likeEsc = (v: string) => v.replace(/[!%_]/g, (c) => "!" + c);

/** WHERE condition (without the keyword) for the rules. Empty rules and blank values are skipped. */
export function buildWhere(rules: FilterRule[], q: Quote): string {
  const parts: string[] = [];
  for (const r of rules) {
    if (!r.col) continue;
    const c = q(r.col);
    let cond = "";
    switch (r.op) {
      case "is null": cond = `${c} IS NULL`; break;
      case "is not null": cond = `${c} IS NOT NULL`; break;
      case "contains": cond = r.value === "" ? "" : `${c} LIKE ${str("%" + likeEsc(r.value) + "%")} ESCAPE '!'`; break;
      case "begins with": cond = r.value === "" ? "" : `${c} LIKE ${str(likeEsc(r.value) + "%")} ESCAPE '!'`; break;
      case "ends with": cond = r.value === "" ? "" : `${c} LIKE ${str("%" + likeEsc(r.value))} ESCAPE '!'`; break;
      case "in list": {
        const items = r.value.split(",").map((s) => s.trim()).filter(Boolean);
        cond = items.length ? `${c} IN (${items.map(literal).join(", ")})` : "";
        break;
      }
      default: cond = r.value === "" ? "" : `${c} ${r.op} ${literal(r.value)}`;
    }
    if (!cond) continue;
    parts.push(parts.length ? `${r.or ? "OR" : "AND"} ${cond}` : cond);
  }
  return parts.join(" ");
}
