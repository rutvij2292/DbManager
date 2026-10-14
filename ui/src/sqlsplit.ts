/** Split editor text into statements at `;`, ignoring semicolons inside strings, quoted identifiers, comments and $$ bodies. */
export interface Stmt { text: string; from: number; to: number }

export function splitStatements(sql: string): Stmt[] {
  const out: Stmt[] = [];
  let start = 0, i = 0;
  const push = (end: number) => {
    const raw = sql.slice(start, end);
    const text = raw.trim();
    if (text && !/^(--[^\n]*\s*)+$/.test(text) && !/^\/\*[\s\S]*\*\/$/.test(text)) {
      const from = start + raw.indexOf(text);
      out.push({ text, from, to: from + text.length });
    }
  };
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\" && c !== "`") { i += 2; continue; }
        if (sql[i] === c) { if (sql[i + 1] === c) { i += 2; continue; } break; }
        i++;
      }
      i++;
    } else if (c === "-" && n === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? sql.length : e + 2;
    } else if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const e = sql.indexOf(tag, i + tag.length);
        i = e < 0 ? sql.length : e + tag.length;
      } else i++;
    } else if (c === ";") {
      push(i);
      start = ++i;
    } else i++;
  }
  push(sql.length);
  return out;
}

/** The statement the cursor is in (or just after, when the cursor sits right behind its `;`). Falls back to the last statement before it. */
export function statementAt(sql: string, pos: number): Stmt | null {
  const all = splitStatements(sql);
  if (!all.length) return null;
  const inside = all.find((s) => pos >= s.from && pos <= s.to + 1);
  if (inside) return inside;
  const before = all.filter((s) => s.to < pos);
  return before.length ? before[before.length - 1] : all[0];
}
