import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { api, type ObjectRef } from "./api";
import { icon } from "./icons";
import { esc, modal, toast } from "./ui";

let jobSeq = 5000;
const mb = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB");
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

export const BACKUP_KINDS = ["sqlite", "mysql", "mariadb", "postgres", "cockroach", "redshift", "greenplum"];

/** Back up the connected database to a SQL file (optionally zipped). */
export function showBackup(connId: number, connName: string, dbName: string, objects: ObjectRef[], done: (msg: string) => void) {
  const tables = objects.filter((o) => o.kind === "table");
  const label = (t: ObjectRef) => (t.schema && t.schema !== "public" ? t.schema + "." : "") + t.name;
  const m = modal(`
    <div class="px-5 pt-4 pb-3 border-b border-line">
      <div class="text-[16px] font-semibold">Back up ${esc(dbName)}</div>
      <div class="text-soft mt-0.5">${esc(connName)} · saved as a SQL script you can restore anywhere.</div>
    </div>
    <div id="body" class="flex flex-col min-h-0">
      <div class="px-5 pt-3 pb-1 flex items-center gap-2"><span class="font-medium">Tables</span><span class="pill" id="count"></span><span class="flex-1"></span>
        <button id="all" class="btn btn-ghost">All</button><button id="none" class="btn btn-ghost">None</button></div>
      <div id="list" class="overflow-auto mx-5 mb-3 rounded-lg border border-line" style="max-height:200px"></div>
      <div class="px-5 pb-3 grid gap-1.5" style="grid-template-columns:1fr 1fr">
        <label class="flex items-center gap-2"><input id="o-structure" type="checkbox" checked/> Structure</label>
        <label class="flex items-center gap-2"><input id="o-data" type="checkbox" checked/> Data</label>
        <label class="flex items-center gap-2"><input id="o-views" type="checkbox" checked/> Views</label>
        <label class="flex items-center gap-2"><input id="o-zip" type="checkbox" checked/> Compress (.zip)</label>
        <label class="flex items-center gap-2" style="grid-column:1/3"><input id="o-drop" type="checkbox"/> Add <span class="mono text-[13px]">DROP TABLE IF EXISTS</span> before each table <span class="text-muted">(replaces tables when restoring)</span></label>
      </div>
      <div id="msg" class="px-5 text-danger min-h-4"></div>
      <div class="px-5 py-3 border-t border-line flex justify-end gap-2"><button id="x" class="btn btn-ghost">Cancel</button><button id="go" class="btn btn-primary">${icon("archive", 14)}<span>Back up…</span></button></div>
    </div>`, 560);
  const checked = new Set(tables.map(label));
  const list = m.q("#list"), count = m.q("#count");
  const draw = () => {
    list.innerHTML = tables.length ? tables.map((t) => `<label class="flex items-center gap-2.5 px-3 h-7 hover:bg-canvas"><input type="checkbox" data-t="${esc(label(t))}" ${checked.has(label(t)) ? "checked" : ""}/><span class="truncate">${esc(label(t))}</span></label>`).join("") : `<div class="px-3 py-4 text-muted text-center">This database has no tables.</div>`;
    list.querySelectorAll<HTMLInputElement>("input[data-t]").forEach((i) => (i.onchange = () => { i.checked ? checked.add(i.dataset.t!) : checked.delete(i.dataset.t!); count.textContent = `${checked.size} of ${tables.length}`; }));
    count.textContent = `${checked.size} of ${tables.length}`;
  };
  m.q("#all").onclick = () => { tables.forEach((t) => checked.add(label(t))); draw(); };
  m.q("#none").onclick = () => { checked.clear(); draw(); };
  m.q("#x").onclick = m.close;
  m.q("#go").onclick = async () => {
    const structure = m.q<HTMLInputElement>("#o-structure").checked, data = m.q<HTMLInputElement>("#o-data").checked;
    if (!structure && !data) { m.q("#msg").textContent = "Choose structure, data, or both."; return; }
    if (!checked.size) { m.q("#msg").textContent = "Choose at least one table."; return; }
    const zip = m.q<HTMLInputElement>("#o-zip").checked;
    const views = m.q<HTMLInputElement>("#o-views").checked, addDrop = m.q<HTMLInputElement>("#o-drop").checked; // read now: the form is replaced by the progress view below
    const path = await save({ defaultPath: `${dbName}_${stamp()}${zip ? ".zip" : ".sql"}`, filters: [{ name: zip ? "Zip archive" : "SQL", extensions: zip ? ["zip"] : ["sql"] }] });
    if (!path) return;
    const job = jobSeq++;
    m.q("#body").innerHTML = `<div class="p-8 text-center"><div id="cur" class="mb-1 text-soft">Starting…</div><div id="rows" class="text-2xl mono mb-3">0 rows</div>
      <div class="h-1.5 rounded bg-raised overflow-hidden mx-6 mb-4"><div id="bar" class="h-1.5 bg-accent" style="width:0%"></div></div>
      <button id="cancel" class="btn">Cancel</button></div>`;
    const un = await listen<{ job: number; table: string; tables_done: number; tables_total: number; rows: number }>("backup-progress", (e) => {
      if (e.payload.job !== job) return;
      m.q("#cur").textContent = `${e.payload.table} · table ${Math.min(e.payload.tables_done + 1, e.payload.tables_total)} of ${e.payload.tables_total}`;
      m.q("#rows").textContent = `${e.payload.rows.toLocaleString()} rows`;
      m.q("#bar").style.width = `${Math.round((e.payload.tables_done / Math.max(1, e.payload.tables_total)) * 100)}%`;
    });
    m.q("#cancel").onclick = () => { api.cancelIo(job); m.q("#cancel").textContent = "Cancelling…"; };
    try {
      const r = await api.backupDatabase(connId, path, {
        tables: checked.size === tables.length ? null : tables.filter((t) => checked.has(label(t))).map((t) => ({ schema: t.schema, name: t.name })),
        structure, data, views, zip, add_drop: addDrop,
      }, job);
      done(`Backed up ${r.tables} table${r.tables === 1 ? "" : "s"}, ${r.rows.toLocaleString()} rows (${mb(r.bytes)}) to ${path}`);
    } catch (e) {
      done(String(e).includes("cancelled") ? "Backup cancelled — nothing was saved" : "Backup failed: " + e);
    } finally { un(); }
    m.close();
  };
  draw();
}

/** Restore a SQL script (plain, .zip or .gz) into the connected database. */
export async function showRestore(connId: number, connName: string, dbName: string, env: string | null | undefined, done: (msg: string) => void) {
  const path = await open({ multiple: false, filters: [{ name: "SQL backup", extensions: ["sql", "zip", "gz"] }, { name: "All", extensions: ["*"] }] });
  if (typeof path !== "string") return;
  const prod = env === "production";
  const m = modal(`
    <div class="px-5 pt-4 pb-3 border-b border-line">
      <div class="text-[16px] font-semibold">Restore a backup</div>
      <div class="text-soft mt-0.5 mono text-[13px] truncate" title="${esc(path)}">${esc(path.split("/").pop() ?? path)}</div>
    </div>
    <div id="body" class="px-5 py-4 flex flex-col gap-3">
      <div class="rounded-lg px-3 py-2.5 ${prod ? "bg-danger-soft" : "bg-warn-soft"}" style="box-shadow: inset 3px 0 0 ${prod ? "var(--danger)" : "var(--warn)"}">
        <div class="font-medium">${prod ? "This is a production database." : "This changes the database."}</div>
        <div class="text-soft text-[13px]">The script runs against <b>${esc(dbName || connName)}</b> on ${esc(connName)}. Statements in it can create, replace or delete tables and data.</div>
      </div>
      <label class="flex items-start gap-2"><input id="keep" type="checkbox" class="mt-0.5"/><span>Keep going after errors<br/><span class="text-muted text-[13px]">Off by default: the restore stops at the first failing statement and tells you which one.</span></span></label>
      ${prod ? `<label class="flex items-start gap-2"><input id="ack" type="checkbox" class="mt-0.5"/><span>I understand this will change the production database.</span></label>` : ""}
      <div class="flex justify-end gap-2 mt-1"><button id="x" class="btn btn-ghost">Cancel</button><button id="go" class="btn ${prod ? "btn-danger" : "btn-primary"}" ${prod ? "disabled" : ""}>${icon("restore", 14)}<span>Restore</span></button></div>
    </div>`, 520);
  m.q("#x").onclick = m.close;
  if (prod) m.q<HTMLInputElement>("#ack").onchange = () => { m.q<HTMLButtonElement>("#go").disabled = !m.q<HTMLInputElement>("#ack").checked; };
  m.q("#go").onclick = async () => {
    const keepGoing = !!m.q<HTMLInputElement>("#keep")?.checked; // read before the form is replaced by the progress view
    const job = jobSeq++;
    m.q("#body").innerHTML = `<div class="p-6 text-center"><div id="cur" class="mb-1 text-soft">Reading the script…</div><div id="pct" class="text-2xl mono mb-3">0%</div>
      <div class="h-1.5 rounded bg-raised overflow-hidden mx-4 mb-4"><div id="bar" class="h-1.5 bg-accent" style="width:0%"></div></div><button id="cancel" class="btn">Cancel</button></div>`;
    const un = await listen<{ job: number; statements: number; bytes_read: number; bytes_total: number }>("restore-progress", (e) => {
      if (e.payload.job !== job) return;
      const pct = e.payload.bytes_total ? Math.min(100, Math.round((e.payload.bytes_read / e.payload.bytes_total) * 100)) : 0;
      m.q("#cur").textContent = `${e.payload.statements.toLocaleString()} statements run`;
      m.q("#pct").textContent = pct + "%";
      m.q("#bar").style.width = pct + "%";
    });
    m.q("#cancel").onclick = () => { api.cancelIo(job); m.q("#cancel").textContent = "Cancelling…"; };
    try {
      const r = await api.restoreDatabase(connId, path, { stop_on_error: !keepGoing }, job);
      un();
      if (!r.failed) { done(`Restored: ${r.statements.toLocaleString()} statements${r.copied_rows ? `, ${r.copied_rows.toLocaleString()} rows copied` : ""}.`); m.close(); return; }
      m.q("#body").innerHTML = `<div class="flex flex-col gap-2"><div class="font-medium text-warn">Finished with ${r.failed} error${r.failed === 1 ? "" : "s"} in ${r.statements.toLocaleString()} statements.</div>
        <div class="overflow-auto rounded-lg border border-line" style="max-height:240px">${r.errors.map(([s, e]) => `<div class="px-3 py-2 border-b border-line last:border-b-0"><div class="mono text-[12px] text-muted truncate" title="${esc(s)}">${esc(s)}</div><div class="text-danger text-[13px]">${esc(e)}</div></div>`).join("")}</div>
        ${r.failed > r.errors.length ? `<div class="text-muted text-[13px]">Showing the first ${r.errors.length}.</div>` : ""}
        <div class="flex justify-end"><button id="ok" class="btn btn-primary">Done</button></div></div>`;
      m.q("#ok").onclick = () => { m.close(); done(`Restore finished with ${r.failed} error${r.failed === 1 ? "" : "s"}.`); };
    } catch (e) {
      un();
      m.close();
      if (String(e).includes("cancelled")) done("Restore cancelled. Statements already run were not rolled back.");
      else { done("Restore stopped: " + String(e).split("\n")[0]); toast(String(e), "error"); }
    }
  };
}
