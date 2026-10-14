import type { PlanNode } from "./api";

export interface Hint { level: "warn" | "info"; msg: string }

const strip = (s: string) => s.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

/** Static, dialect-agnostic checks on SQL text. Cheap enough to run on demand for the current statement. */
export function lintSql(sql: string): Hint[] {
  const raw = sql;
  const q = strip(sql).replace(/\s+/g, " ").trim();
  const l = q.toLowerCase();
  const out: Hint[] = [];
  const add = (level: Hint["level"], msg: string) => out.push({ level, msg });

  if (/^(update|delete)\b/.test(l) && !/\bwhere\b/.test(l)) add("warn", "UPDATE/DELETE without WHERE affects every row.");
  if (/\bselect\s+(distinct\s+)?\*/.test(l) || /,\s*\*\s+from/.test(l)) add("info", "SELECT * reads every column; list only what you need (enables covering indexes, less I/O).");
  if (/\blike\s+'%/.test(raw.toLowerCase().replace(/\s+/g, " "))) add("warn", "LIKE with a leading wildcard cannot use a B-tree index.");
  if (/\bwhere\b[^;]*\b(lower|upper|date|cast|substr|substring|trim|coalesce|extract|year|month)\s*\(\s*[\w."]+\s*[,)]/.test(l)) add("warn", "A function wraps a column in WHERE; the index on that column can't be used. Compare against a transformed constant or add an expression index.");
  if (/\bnot\s+in\s*\(\s*select\b/.test(l)) add("warn", "NOT IN (subquery) returns no rows if the subquery yields a NULL; prefer NOT EXISTS.");
  if (/\bfrom\s+[\w."]+(\s+(as\s+)?\w+)?\s*,\s*[\w."]+/.test(l) && !/\bjoin\b/.test(l)) add("warn", "Comma-separated tables form a cross join unless WHERE links them; use explicit JOIN … ON.");
  const off = /\boffset\s+(\d+)/.exec(l);
  if (off && +off[1] >= 10000) add("info", `OFFSET ${off[1]} scans and discards that many rows; use keyset pagination (WHERE id > last_id).`);
  if (/\border by\b/.test(l) && !/\blimit\b|\btop\b|\bfetch\b/.test(l) && /^select/.test(l)) add("info", "ORDER BY without LIMIT sorts the whole result.");
  if (/\bselect\s+distinct\b/.test(l) && /\bjoin\b/.test(l)) add("info", "DISTINCT with JOIN often hides duplicate rows from a join that is too wide; check the join keys.");
  const orCols = /\bwhere\b(.*)/.exec(l)?.[1].split(/\bor\b/).map((p) => /([\w."]+)\s*(=|<|>|like|in)\b/.exec(p.trim())?.[1]).filter(Boolean);
  if (orCols && new Set(orCols).size > 1 && orCols.length > 1) add("info", "OR across different columns often defeats indexes; consider UNION ALL of two indexed queries.");
  if (/\bselect\b[^;]*\(\s*select\b[^)]*\bwhere\b[^)]*\)[^;]*\bfrom\b/.test(l)) add("info", "A correlated subquery in the SELECT list runs once per row; a JOIN is usually faster.");
  return out;
}

/** Findings that only a real plan can show. */
export function lintPlan(root: PlanNode): Hint[] {
  const out: Hint[] = [];
  const walk = (n: PlanNode) => {
    const op = n.op.toLowerCase();
    const rel = n.relation ? ` on ${n.relation}` : "";
    const scan = op.includes("seq scan") || op.includes("full table scan") || /^scan\b/.test(op) && !/using/i.test(n.detail);
    if (scan && (n.est_rows ?? 0) >= 1000) out.push({ level: "warn", msg: `Full scan${rel} (~${Math.round(n.est_rows!).toLocaleString()} rows). An index on the filtered/joined column may help.` });
    else if (scan && n.est_rows === undefined && /^scan\b/i.test(n.op)) out.push({ level: "info", msg: `${n.detail} — SQLite is scanning without an index.` });
    if (n.actual_rows != null && n.est_rows != null && n.est_rows > 0) {
      const ratio = Math.max(n.actual_rows / n.est_rows, n.est_rows / Math.max(n.actual_rows, 1));
      if (ratio >= 10 && Math.max(n.actual_rows, n.est_rows) >= 100) out.push({ level: "info", msg: `${n.op}${rel}: estimated ${Math.round(n.est_rows)} rows but got ${Math.round(n.actual_rows)}; run ANALYZE to refresh statistics.` });
    }
    if (op.includes("temp b-tree") || /using (temporary|filesort)/i.test(n.detail)) out.push({ level: "info", msg: `${n.op}${rel}: uses a temporary structure/sort; an index matching the ORDER BY/GROUP BY can avoid it.` });
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}
