/** Short, readable name for one statement's result tab: "SELECT users", "UPDATE orders", "CREATE TABLE t". */
const stripNoise = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
const IDENT = String.raw`((?:[\w$]+|"[^"]+"|` + "`[^`]+`" + String.raw`|\[[^\]]+\])(?:\.(?:[\w$]+|"[^"]+"|` + "`[^`]+`" + String.raw`|\[[^\]]+\]))*)`;
const clean = (id: string) => id.replace(/["`\[\]]/g, "");

export function statementLabel(sql: string, max = 28): string {
  const s = stripNoise(sql);
  const first = (/^\(?\s*(\w+)/.exec(s)?.[1] ?? "").toUpperCase();
  let m: RegExpExecArray | null;
  let out: string;
  if (first === "SELECT" || first === "WITH" || first === "VALUES" || first === "TABLE") {
    m = new RegExp(String.raw`\bFROM\s+${IDENT}`, "i").exec(s);
    out = first === "WITH" ? "WITH" + (m ? " " + clean(m[1]) : "") : m ? `SELECT ${clean(m[1])}` : first;
  } else if (first === "INSERT") { m = new RegExp(String.raw`\bINTO\s+${IDENT}`, "i").exec(s); out = m ? `INSERT ${clean(m[1])}` : "INSERT"; }
  else if (first === "UPDATE") { m = new RegExp(String.raw`^UPDATE\s+(?:ONLY\s+)?${IDENT}`, "i").exec(s); out = m ? `UPDATE ${clean(m[1])}` : "UPDATE"; }
  else if (first === "DELETE") { m = new RegExp(String.raw`\bFROM\s+${IDENT}`, "i").exec(s); out = m ? `DELETE ${clean(m[1])}` : "DELETE"; }
  else if (first === "CREATE" || first === "ALTER" || first === "DROP" || first === "TRUNCATE") {
    m = new RegExp(String.raw`^(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?:OR\s+REPLACE\s+|TEMP(?:ORARY)?\s+|UNIQUE\s+)*(TABLE|VIEW|INDEX|DATABASE|SCHEMA|TRIGGER|FUNCTION|PROCEDURE|SEQUENCE|TYPE)?\s*(?:IF\s+(?:NOT\s+)?EXISTS\s+)?${IDENT}?`, "i").exec(s);
    out = [first, m?.[1]?.toUpperCase(), m?.[2] ? clean(m[2]) : ""].filter(Boolean).join(" ");
  } else out = s.split(" ").slice(0, 2).join(" ") || "Statement";
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

export interface ResultInfo { sql: string; error?: string; hasRows: boolean; count: number; ms?: number }

/** "users · 20 rows · 4 ms" style text for a result tab. */
export function resultCaption(r: ResultInfo): { label: string; detail: string } {
  const label = statementLabel(r.sql);
  if (r.error) return { label, detail: "error" };
  const n = r.count.toLocaleString();
  const what = r.hasRows ? `${n} row${r.count === 1 ? "" : "s"}` : `${n} affected`;
  return { label, detail: r.ms !== undefined ? `${what} · ${r.ms} ms` : what };
}
