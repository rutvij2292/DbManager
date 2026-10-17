/** Database / table administration: the SQL for each engine, plus the confirmation dialogs. */
import { esc, modal } from "./ui";

export const SYSTEM_DBS = new Set(["information_schema", "performance_schema", "mysql", "sys", "template0", "template1", "postgres", "admin", "local", "config", "master", "model", "msdb", "tempdb"]);

const isMy = (k: string) => k === "mysql" || k === "mariadb";
const quoteFor = (k: string) => (s: string) => (k === "mssql" ? `[${s.replace(/]/g, "]]")}]` : isMy(k) ? "`" + s.replace(/`/g, "``") + "`" : `"${s.replace(/"/g, '""')}"`);
export interface TableRef { schema: string | null; name: string; kind?: string }
const qualified = (k: string, t: TableRef) => {
  const q = quoteFor(k);
  return t.schema && !isMy(k) && k !== "sqlite" && t.schema !== "public" ? `${q(t.schema)}.${q(t.name)}` : q(t.name);
};

/** Engines that can create and drop databases on a server. */
export const canManageDatabases = (kind: string) => isMy(kind) || kind === "postgres" || kind === "mssql";
/** Engines where every table of a database can be emptied in one go. */
export const canTruncateAll = (kind: string) => isMy(kind) || kind === "postgres" || kind === "sqlite";

export function createDatabaseSql(kind: string, name: string): string | null {
  return canManageDatabases(kind) ? `CREATE DATABASE ${quoteFor(kind)(name)}` : null;
}

/** Statements that drop a database. They must run from a connection that isn't inside it (Postgres, SQL Server). */
export function dropDatabaseSql(kind: string, name: string, force = true): string[] {
  const q = quoteFor(kind)(name);
  if (kind === "postgres") return [`DROP DATABASE ${q}${force ? " WITH (FORCE)" : ""}`];
  if (kind === "mssql") return [`ALTER DATABASE ${q} SET SINGLE_USER WITH ROLLBACK IMMEDIATE`, `DROP DATABASE ${q}`];
  return [`DROP DATABASE ${q}`];
}

/** Empty every table of the open database, keeping the structure. Null when the engine can't do it safely. */
export function truncateAllSql(kind: string, tables: TableRef[]): string[] | null {
  if (!canTruncateAll(kind)) return null;
  if (!tables.length) return [];
  if (isMy(kind)) return ["SET FOREIGN_KEY_CHECKS=0", ...tables.map((t) => `TRUNCATE TABLE ${qualified(kind, t)}`), "SET FOREIGN_KEY_CHECKS=1"];
  if (kind === "postgres") return [`TRUNCATE TABLE ${tables.map((t) => qualified(kind, t)).join(", ")} RESTART IDENTITY CASCADE`];
  return tables.map((t) => `DELETE FROM ${qualified(kind, t)}`);
}

/** Engines where foreign keys can be bypassed for one operation (SQL Server can't without dropping the constraints). */
export const canIgnoreForeignKeys = (kind: string) => kind !== "mssql";

/** Run `sql` with foreign-key enforcement off for just that statement, like phpMyAdmin's checkbox. */
function withoutForeignKeys(kind: string, sql: string | string[], ignore: boolean): string[] {
  const body = Array.isArray(sql) ? sql : [sql];
  if (!ignore) return body;
  if (isMy(kind)) return ["SET FOREIGN_KEY_CHECKS=0", ...body, "SET FOREIGN_KEY_CHECKS=1"];
  if (kind === "sqlite") return ["PRAGMA foreign_keys=OFF", ...body, "PRAGMA foreign_keys=ON"];
  return body; // PostgreSQL: handled with CASCADE on the statement itself
}

export function truncateTableSql(kind: string, t: TableRef, ignoreFk = false): string[] {
  if (kind === "sqlite") return withoutForeignKeys(kind, `DELETE FROM ${qualified(kind, t)}`, ignoreFk);
  if (kind === "postgres") return [`TRUNCATE TABLE ${qualified(kind, t)}${ignoreFk ? " CASCADE" : ""}`];
  return withoutForeignKeys(kind, `TRUNCATE TABLE ${qualified(kind, t)}`, ignoreFk);
}

export function dropTableSql(kind: string, t: TableRef, ignoreFk = false): string[] {
  const sql = `DROP ${t.kind === "view" ? "VIEW" : "TABLE"} ${qualified(kind, t)}`;
  if (kind === "postgres") return [`${sql}${ignoreFk ? " CASCADE" : ""}`];
  return withoutForeignKeys(kind, sql, ignoreFk);
}

/** Truncate several tables in one batch. Foreign keys are switched off once around the whole batch. */
export function truncateTablesSql(kind: string, tables: TableRef[], ignoreFk = false): string[] {
  const list = tables.filter((t) => t.kind !== "view");
  if (!list.length) return [];
  if (kind === "postgres") return [`TRUNCATE TABLE ${list.map((t) => qualified(kind, t)).join(", ")}${ignoreFk ? " CASCADE" : ""}`];
  const one = (t: TableRef) => (kind === "sqlite" ? `DELETE FROM ${qualified(kind, t)}` : `TRUNCATE TABLE ${qualified(kind, t)}`);
  return withoutForeignKeys(kind, list.map(one), ignoreFk);
}

/** Drop several tables and views in one batch (views first, so a view never outlives its table mid-batch). */
export function dropTablesSql(kind: string, tables: TableRef[], ignoreFk = false): string[] {
  const views = tables.filter((t) => t.kind === "view"), tabs = tables.filter((t) => t.kind !== "view");
  const cascade = ignoreFk ? " CASCADE" : "";
  if (kind === "postgres") {
    const names = (l: TableRef[]) => l.map((t) => qualified(kind, t)).join(", ");
    return [...(views.length ? [`DROP VIEW ${names(views)}${cascade}`] : []), ...(tabs.length ? [`DROP TABLE ${names(tabs)}${cascade}`] : [])];
  }
  const stmts = [...views.map((t) => `DROP VIEW ${qualified(kind, t)}`), ...tabs.map((t) => `DROP TABLE ${qualified(kind, t)}`)];
  return stmts.length ? withoutForeignKeys(kind, stmts, ignoreFk && tabs.length > 0) : [];
}

/** What the "ignore foreign keys" option does, per engine, for the checkbox label. */
export function ignoreFkLabel(kind: string, op: "truncate" | "drop"): string {
  if (kind === "postgres") return op === "truncate" ? "Also empty tables that reference it (CASCADE)" : "Also remove foreign keys that reference it (CASCADE)";
  return "Ignore foreign key constraints for this operation";
}

/** Did the server refuse because of a foreign key? */
export const isForeignKeyError = (msg: string) => /foreign key|\b(1701|1451|1217|3730)\b|referenced in a foreign|REFERENCE constraint/i.test(msg);

/** Ask for a name (new database). Resolves null when dismissed. */
export function promptName(title: string, hint: string, confirmLabel: string, initial = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const m = modal(`
      <div class="px-5 pt-4 pb-2"><div class="text-[16px] font-semibold">${esc(title)}</div><div class="text-soft mt-0.5">${esc(hint)}</div></div>
      <div class="px-5 pb-3"><input id="n" class="field w-full" autocomplete="off" placeholder="name" value="${esc(initial)}"/><div id="msg" class="text-danger text-[12.5px] mt-1.5 h-4"></div></div>
      <div class="px-5 py-3 border-t border-line flex justify-end gap-2"><button id="no" class="btn">Cancel</button><button id="yes" class="btn btn-primary">${esc(confirmLabel)}</button></div>`, 440);
    let done = false;
    const finish = (v: string | null) => { if (done) return; done = true; m.close(); resolve(v); };
    m.onClose = () => finish(null);
    const n = m.q<HTMLInputElement>("#n");
    const go = () => {
      const v = n.value.trim();
      if (!v) { m.q("#msg").textContent = "Enter a name."; return; }
      if (/[\u0000-\u001f]/.test(v)) { m.q("#msg").textContent = "That name has control characters."; return; }
      finish(v);
    };
    m.q("#no").onclick = () => finish(null);
    m.q("#yes").onclick = go;
    n.onkeydown = (e) => { if (e.key === "Enter") go(); };
    n.focus(); n.select();
  });
}

/**
 * Confirm something destructive. With `typed`, the red button stays disabled until that exact name is typed in
 * (databases, and anything on a production connection); without it a plain confirm is shown.
 */
export function confirmDanger(opts: { title: string; body: string; confirmLabel: string; typed?: string; sql?: string[]; option?: { label: string; checked: boolean } }): Promise<boolean> {
  return new Promise((resolve) => {
    const m = modal(`
      <div class="px-5 pt-4 pb-2"><div class="text-[16px] font-semibold text-danger">${esc(opts.title)}</div><div class="text-soft mt-1">${opts.body}</div></div>
      ${opts.sql?.length ? `<pre id="sql" class="mono text-[12.5px] mx-5 mb-2 p-2.5 rounded-lg bg-canvas overflow-auto select-text whitespace-pre-wrap" style="max-height:140px"></pre>` : ""}
      ${opts.option ? `<label class="flex items-center gap-2 px-5 pb-3"><input id="opt" type="checkbox"${opts.option.checked ? " checked" : ""}/> ${esc(opts.option.label)}</label>` : ""}
      ${opts.typed ? `<div class="px-5 pb-3"><div class="text-[12.5px] text-muted mb-1">Type <b class="text-ink">${esc(opts.typed)}</b> to confirm</div><input id="t" class="field w-full" autocomplete="off"/></div>` : ""}
      <div class="px-5 py-3 border-t border-line flex justify-end gap-2"><button id="no" class="btn">Cancel</button><button id="yes" class="btn btn-careful"${opts.typed ? " disabled" : ""}>${esc(opts.confirmLabel)}</button></div>`, 500);
    if (opts.sql?.length) m.q("#sql").textContent = opts.sql.join(";\n") + ";";
    let done = false;
    const finish = (v: boolean) => { if (done) return; done = true; m.close(); resolve(v); };
    m.onClose = () => finish(false);
    const yes = m.q<HTMLButtonElement>("#yes");
    if (opts.option) m.q<HTMLInputElement>("#opt").onchange = (e) => { opts.option!.checked = (e.target as HTMLInputElement).checked; };
    m.q("#no").onclick = () => finish(false);
    yes.onclick = () => finish(true);
    if (opts.typed) {
      const t = m.q<HTMLInputElement>("#t");
      t.oninput = () => { yes.disabled = t.value !== opts.typed; };
      t.onkeydown = (e) => { if (e.key === "Enter" && !yes.disabled) finish(true); };
      t.focus();
    } else yes.focus();
  });
}

/** A statement typed into the editor that destroys data. `drop` and `truncate` are blocked on protected connections. */
export type Destructive = { kind: "drop" | "truncate" | "delete-all" | "update-all"; statement: string };
export function destructiveKind(sql: string): Destructive | null {
  const clean = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  for (const raw of clean.split(";")) {
    const st = raw.trim();
    if (!st) continue;
    const l = st.toLowerCase();
    if (/^drop\s+(table|database|schema|view|index|trigger|function|procedure|event|sequence|type)\b/.test(l)) return { kind: "drop", statement: st };
    if (/^truncate\b/.test(l)) return { kind: "truncate", statement: st };
    if (/^delete\s+from\b/.test(l) && !/\bwhere\b/.test(l)) return { kind: "delete-all", statement: st };
    if (/^update\b/.test(l) && !/\bwhere\b/.test(l)) return { kind: "update-all", statement: st };
  }
  return null;
}

// ---------- read-only check (mirror of dbcore::is_read_only_sql; the backend enforces it, this only gives early, friendly feedback) ----------
function scrub(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(--|#)[^\n]*/g, " ").replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`[^`]*`/g, " _ ");
}
const WRITE_WORDS = new Set(["insert", "update", "delete", "replace", "merge", "drop", "create", "alter", "truncate", "grant", "revoke", "rename", "call", "exec", "execute", "into", "copy", "load", "lock", "vacuum", "reindex", "attach", "detach", "set", "do", "handler"]);
const wordsOf = (s: string) => s.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
function statementIsRead(st: string): boolean {
  const w = wordsOf(st);
  if (!w.length) return true;
  const first = w[0];
  if (["show", "describe", "desc", "use", "values", "table", "begin", "commit", "rollback"].includes(first)) return true;
  if (first === "start") return w[1] === "transaction";
  if (["select", "with", "explain"].includes(first)) return !w.slice(1).some((x) => WRITE_WORDS.has(x) && !(x === "set" && first === "explain"));
  if (first === "pragma") return !st.includes("=") && !st.includes("(");
  return false;
}
/** True when every statement in `sql` only reads. */
export const isReadOnlySql = (sql: string) => scrub(sql).split(";").every((st) => statementIsRead(st.trim()));

export type Safety = "off" | "protected" | "readonly";
/** The safety level of a saved connection (older profiles only had a `protect` flag). */
export function safetyLevel(p: { safety?: string | null; protect?: boolean | null; environment?: string | null }): Safety {
  if (p.safety === "off" || p.safety === "protected" || p.safety === "readonly") return p.safety;
  if (p.protect === true) return "protected";
  if (p.protect === false) return "off";
  return p.environment === "production" ? "protected" : "off";
}
