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
function withoutForeignKeys(kind: string, sql: string, ignore: boolean): string[] {
  if (!ignore) return [sql];
  if (isMy(kind)) return ["SET FOREIGN_KEY_CHECKS=0", sql, "SET FOREIGN_KEY_CHECKS=1"];
  if (kind === "sqlite") return ["PRAGMA foreign_keys=OFF", sql, "PRAGMA foreign_keys=ON"];
  return [sql]; // PostgreSQL: handled with CASCADE on the statement itself
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

/** What the "ignore foreign keys" option does, per engine, for the checkbox label. */
export function ignoreFkLabel(kind: string, op: "truncate" | "drop"): string {
  if (kind === "postgres") return op === "truncate" ? "Also empty tables that reference it (CASCADE)" : "Also remove foreign keys that reference it (CASCADE)";
  return "Ignore foreign key constraints for this operation";
}

/** Did the server refuse because of a foreign key? */
export const isForeignKeyError = (msg: string) => /foreign key|\b(1701|1451|1217|3730)\b|referenced in a foreign|REFERENCE constraint/i.test(msg);

/** Ask for a name (new database). Resolves null when dismissed. */
export function promptName(title: string, hint: string, confirmLabel: string): Promise<string | null> {
  return new Promise((resolve) => {
    const m = modal(`
      <div class="px-5 pt-4 pb-2"><div class="text-[16px] font-semibold">${esc(title)}</div><div class="text-soft mt-0.5">${esc(hint)}</div></div>
      <div class="px-5 pb-3"><input id="n" class="field w-full" autocomplete="off" placeholder="name"/><div id="msg" class="text-danger text-[12.5px] mt-1.5 h-4"></div></div>
      <div class="px-5 py-3 border-t border-line flex justify-end gap-2"><button id="no" class="btn">Cancel</button><button id="yes" class="btn btn-primary">${esc(confirmLabel)}</button></div>`, 440);
    let done = false;
    const finish = (v: string | null) => { if (done) return; done = true; m.close(); resolve(v); };
    new MutationObserver(() => { if (!document.body.contains(m.o)) finish(null); }).observe(document.body, { childList: true });
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
    n.focus();
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
    new MutationObserver(() => { if (!document.body.contains(m.o)) finish(false); }).observe(document.body, { childList: true });
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
