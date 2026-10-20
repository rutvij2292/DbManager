import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { snippetCompletion } from "@codemirror/autocomplete";
import type { SchemaTable } from "./api";

/** Context-aware SQL completion (tables after FROM/JOIN, columns via aliases, join hints, snippets). */

const NOT_ALIAS = new Set(["where", "on", "join", "inner", "left", "right", "full", "cross", "natural", "group", "order", "having", "limit", "union", "set", "using", "values", "select", "offset", "returning"]);
const CLAUSE = /\b(select|from|join|where|on|group\s+by|order\s+by|having|set|into|update|values|and|or|using|limit)\b/gi;

export const FUNCTIONS = ["COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "NULLIF", "LOWER", "UPPER", "LENGTH", "TRIM", "SUBSTRING", "REPLACE", "CONCAT", "ROUND", "ABS", "CAST", "NOW", "DATE", "EXTRACT", "ROW_NUMBER", "RANK", "DENSE_RANK", "LAG", "LEAD", "STRING_AGG", "GROUP_CONCAT", "JSON_EXTRACT"];
const KEYWORDS = ["SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "JOIN", "LEFT JOIN", "INNER JOIN", "RIGHT JOIN", "ON", "AS", "AND", "OR", "NOT", "IN", "EXISTS", "BETWEEN", "LIKE", "IS NULL", "IS NOT NULL", "DISTINCT", "UNION", "UNION ALL", "CASE WHEN", "THEN", "ELSE", "END", "ASC", "DESC", "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "CREATE TABLE", "ALTER TABLE", "DROP TABLE", "WITH", "EXPLAIN"];
const SNIPPETS: Completion[] = [
  snippetCompletion("SELECT ${*} FROM ${table}", { label: "sel", detail: "SELECT … FROM", type: "text" }),
  snippetCompletion("SELECT COUNT(*) FROM ${table}", { label: "selc", detail: "row count", type: "text" }),
  snippetCompletion("INSERT INTO ${table} (${columns})\nVALUES (${values});", { label: "ins", detail: "INSERT", type: "text" }),
  snippetCompletion("UPDATE ${table}\nSET ${column} = ${value}\nWHERE ${condition};", { label: "upd", detail: "UPDATE", type: "text" }),
  snippetCompletion("DELETE FROM ${table}\nWHERE ${condition};", { label: "del", detail: "DELETE", type: "text" }),
  snippetCompletion("SELECT ${col}, COUNT(*)\nFROM ${table}\nGROUP BY ${col}\nORDER BY COUNT(*) DESC;", { label: "grp", detail: "group & count", type: "text" }),
  snippetCompletion("SELECT ${a}.*, ${b}.*\nFROM ${table1} ${a}\nJOIN ${table2} ${b} ON ${b}.${fk} = ${a}.${pk};", { label: "jn", detail: "JOIN two tables", type: "text" }),
  snippetCompletion("SELECT ${a}.*\nFROM ${table1} ${a}\nLEFT JOIN ${table2} ${b} ON ${b}.${fk} = ${a}.${pk}\nWHERE ${b}.${pk} IS NULL;", { label: "ljn", detail: "rows without a match", type: "text" }),
  snippetCompletion("WITH ${name} AS (\n  SELECT ${*}\n  FROM ${table}\n)\nSELECT * FROM ${name};", { label: "cte", detail: "WITH … AS", type: "text" }),
  snippetCompletion("SELECT ${col}, COUNT(*)\nFROM ${table}\nGROUP BY ${col}\nHAVING COUNT(*) > 1;", { label: "dup", detail: "find duplicates", type: "text" }),
  snippetCompletion("SELECT * FROM ${table}\nORDER BY ${col} DESC\nLIMIT 100;", { label: "top", detail: "latest 100", type: "text" }),
  snippetCompletion("CASE WHEN ${condition} THEN ${a} ELSE ${b} END", { label: "case", detail: "CASE expression", type: "text" }),
  snippetCompletion("EXISTS (SELECT 1 FROM ${table} WHERE ${condition})", { label: "ex", detail: "EXISTS", type: "text" }),
  snippetCompletion("SELECT COUNT(*) - COUNT(${col}) AS nulls FROM ${table};", { label: "nulls", detail: "count NULLs", type: "text" }),
  snippetCompletion("CREATE TABLE ${name} (\n  id BIGINT PRIMARY KEY,\n  ${col} VARCHAR(255)\n);", { label: "ct", detail: "CREATE TABLE", type: "text" }),
  snippetCompletion("CREATE INDEX ${name} ON ${table} (${columns});", { label: "idx", detail: "CREATE INDEX", type: "text" }),
  snippetCompletion("ALTER TABLE ${table} ADD COLUMN ${col} ${type};", { label: "alt", detail: "ADD COLUMN", type: "text" }),
];

const usage = (() => {
  try { return JSON.parse(localStorage.getItem("tabnix.usage") ?? "{}") as Record<string, number>; } catch { return {}; }
})();
let saveTimer: number | undefined;
function bump(label: string) {
  usage[label] = (usage[label] ?? 0) + 1;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => localStorage.setItem("tabnix.usage", JSON.stringify(usage)), 1000);
}
const boostFor = (label: string) => Math.min(20, usage[label] ?? 0);

function stripNoise(s: string): string {
  return s.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The statement containing the cursor, with the cursor offset inside it. */
function currentStatement(doc: string, pos: number): { text: string; cursor: number } {
  const start = doc.lastIndexOf(";", pos - 1) + 1;
  let end = doc.indexOf(";", pos);
  if (end < 0) end = doc.length;
  return { text: doc.slice(start, end), cursor: pos - start };
}

const unq = (s: string) => s.replace(/[`"\[\]]/g, "");

interface Ref { alias: string; table: SchemaTable }

function findRefs(stmt: string, tables: SchemaTable[]): Ref[] {
  const refs: Ref[] = [];
  const re = /\b(?:from|join|update|into)\s+([\w."`\[\]]+)(?:\s+(?:as\s+)?(\w+))?/gi;
  for (let m; (m = re.exec(stmt)); ) {
    const name = unq(m[1]);
    const [a, b] = name.includes(".") ? name.split(".") : [null, name];
    const t = tables.find((t) => t.name.toLowerCase() === b.toLowerCase() && (!a || (t.schema ?? "").toLowerCase() === a.toLowerCase()))
      ?? tables.find((t) => t.name.toLowerCase() === b.toLowerCase());
    if (!t) continue;
    const alias = m[2] && !NOT_ALIAS.has(m[2].toLowerCase()) ? m[2] : t.name;
    refs.push({ alias, table: t });
  }
  return refs;
}

function lastClause(before: string): string {
  let last = "";
  for (let m; (m = CLAUSE.exec(before)); ) last = m[1].toLowerCase().replace(/\s+/g, " ");
  CLAUSE.lastIndex = 0;
  return last;
}

export function makeCompletionSource(getTables: () => SchemaTable[]) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const word = ctx.matchBefore(/[\w$]*/);
    const dotted = ctx.matchBefore(/[\w"`]+\.[\w$]*/);
    if (!ctx.explicit && !word?.text && !dotted) return null;
    const tables = getTables();
    const doc = ctx.state.doc.toString();
    const { text, cursor } = currentStatement(doc, ctx.pos);
    const clean = stripNoise(text);
    const before = clean.slice(0, cursor);

    // alias.<column>  or  schema.<table>
    if (dotted) {
      const dot = dotted.text.lastIndexOf(".");
      const qual = unq(dotted.text.slice(0, dot));
      const from = dotted.from + dot + 1;
      const ref = findRefs(clean, tables).find((r) => r.alias.toLowerCase() === qual.toLowerCase());
      if (ref) {
        return { from, options: ref.table.columns.map((c) => ({ label: c, type: "property", detail: ref.table.name, boost: boostFor(c) })) };
      }
      // No FROM yet (e.g. while writing COUNT(DISTINCT tbl.): a plain table name qualifies too.
      const named = tables.find((t) => t.name.toLowerCase() === qual.toLowerCase());
      if (named) return { from, options: named.columns.map((c) => ({ label: c, type: "property", detail: named.name, boost: boostFor(c) })) };
      const inSchema = tables.filter((t) => (t.schema ?? "").toLowerCase() === qual.toLowerCase());
      if (inSchema.length) return { from, options: inSchema.map((t) => ({ label: t.name, type: "class", boost: boostFor(t.name) })) };
      return null;
    }

    const from = word ? word.from : ctx.pos;
    const clause = lastClause(before);
    const options: Completion[] = [];
    const tableOpt = (t: SchemaTable): Completion => ({
      label: t.schema && t.schema !== "public" ? `${t.schema}.${t.name}` : t.name,
      type: "class", detail: `${t.columns.length} cols`, boost: 10 + boostFor(t.name),
    });

    if (["from", "join", "into", "update"].includes(clause)) {
      options.push(...tables.map(tableOpt));
    } else if (clause === "on" || clause === "using") {
      // Join hints: alias.col = other.col for same-named columns, id-style foreign keys.
      const refs = findRefs(clean, tables);
      const last = refs[refs.length - 1];
      if (last) {
        for (const prev of refs.slice(0, -1)) {
          for (const c of last.table.columns) {
            const fk = c.toLowerCase();
            const hit = prev.table.columns.find((p) => p.toLowerCase() === fk)
              ?? (fk === `${prev.table.name.toLowerCase()}_id` || fk === `${prev.table.name.toLowerCase().replace(/s$/, "")}_id` ? prev.table.columns.find((p) => p.toLowerCase() === "id") : undefined);
            if (hit) options.push({ label: `${last.alias}.${c} = ${prev.alias}.${hit}`, type: "keyword", detail: "join", boost: 30 });
          }
        }
      }
      options.push(...columnsOf(refs));
    } else if (clause) {
      const refs = findRefs(clean, tables);
      if (refs.length) options.push(...columnsOf(refs));
      else options.push(...looseColumns(tables), ...tables.map(tableOpt)); // no FROM yet: every column, and tables to qualify with
      options.push(...FUNCTIONS.map((f) => ({ label: f, type: "function", apply: f + "(", boost: -5 + boostFor(f) })));
    }
    // Aliases are valid qualifiers anywhere an expression is.
    if (!["from", "join", "into", "update"].includes(clause)) {
      for (const r of findRefs(clean, tables)) options.push({ label: r.alias, type: "variable", detail: r.table.name, boost: 5 });
    }
    options.push(...KEYWORDS.map((k) => ({ label: k, type: "keyword", boost: -10 + boostFor(k) })));
    if (!clause || clause === "") options.push(...SNIPPETS);
    return { from, options, validFor: /^[\w$]*$/ };
  };
}

function columnsOf(refs: Ref[]): Completion[] {
  const multi = refs.length > 1;
  const out: Completion[] = [];
  for (const r of refs) {
    for (const c of r.table.columns) {
      out.push({ label: c, apply: multi ? `${r.alias}.${c}` : c, type: "property", detail: r.table.name, boost: 15 + boostFor(c) });
    }
  }
  return out;
}

/** Columns of every table, for a statement that has no FROM yet. A name shared by several tables is listed once and says where it lives. */
function looseColumns(tables: SchemaTable[]): Completion[] {
  const where = new Map<string, string[]>();
  for (const t of tables) for (const c of t.columns) where.set(c, [...(where.get(c) ?? []), t.name]);
  return [...where].slice(0, 2000).map(([c, ts]) => ({
    label: c, type: "property", boost: 12 + boostFor(c),
    detail: ts.length <= 3 ? ts.join(", ") : `${ts.slice(0, 2).join(", ")} +${ts.length - 2}`,
  }));
}

/** Remember accepted completions so frequent picks float to the top. */
export function recordAccepted(label: string) { bump(label); }
