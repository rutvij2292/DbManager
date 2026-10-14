import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { api, type ExportFormat, type ImportPreview, type ObjectRef } from "./api";

const field = "bg-panel border border-line-strong rounded px-2 py-1 outline-none focus:border-accent";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
let jobSeq = 1;

function modal(inner: string, width = 560) {
  const o = document.createElement("div");
  o.className = "fixed inset-0 bg-black/50 flex items-center justify-center z-50 select-none";
  o.innerHTML = `<div class="bg-raised rounded-lg border border-line-strong shadow-2xl flex flex-col max-h-[85vh]" style="width:${width}px">${inner}</div>`;
  document.body.append(o);
  const close = () => { o.remove(); window.removeEventListener("keydown", onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  window.addEventListener("keydown", onKey, true);
  return { o, close, q: <T extends HTMLElement>(s: string) => o.querySelector(s) as T };
}

/** Run a job while showing live row counts; `Cancel` stops it in Rust. */
async function withProgress<T>(m: ReturnType<typeof modal>, job: number, label: string, run: () => Promise<T>): Promise<T> {
  const body = m.q("#body");
  body.innerHTML = `<div class="p-6 text-center"><div class="mb-2">${esc(label)}</div><div id="count" class="text-2xl mono mb-3">0 rows</div>
    <button id="cancel" class="px-3 py-1 rounded bg-raised2 hover:bg-raised2">Cancel</button></div>`;
  const started = performance.now();
  const un = await listen<{ job: number; rows: number }>("io-progress", (e) => {
    if (e.payload.job !== job) return;
    const secs = (performance.now() - started) / 1000;
    m.q("#count").textContent = `${e.payload.rows.toLocaleString()} rows` + (secs > 0.5 ? ` · ${Math.round(e.payload.rows / secs).toLocaleString()}/s` : "");
  });
  m.q("#cancel").onclick = () => { api.cancelIo(job); m.q("#cancel").textContent = "Cancelling…"; };
  try { return await run(); } finally { un(); }
}

const EXT: Record<ExportFormat, string> = { csv: "csv", tsv: "tsv", json: "json", jsonl: "jsonl", sql: "sql" };

/** Export dialog. `sql` is run in full (no row cap) and streamed to the chosen file. */
export function showExport(connId: number, sql: string, suggestedName: string, status: (s: string) => void) {
  const m = modal(`
    <div class="px-4 py-2 border-b border-line-strong font-semibold">Export</div>
    <div id="body" class="p-4 flex flex-col gap-3 text-[12.5px] overflow-auto">
      <div class="flex gap-4 flex-wrap" id="fmts">
        ${(["csv", "tsv", "json", "jsonl", "sql"] as ExportFormat[]).map((f, i) => `<label class="flex items-center gap-1"><input type="radio" name="fmt" value="${f}" ${i === 0 ? "checked" : ""}/>${({ csv: "CSV", tsv: "TSV", json: "JSON", jsonl: "JSON Lines", sql: "SQL INSERTs" })[f]}</label>`).join("")}
      </div>
      <label class="flex items-center gap-2"><input type="checkbox" id="hdr" checked/> Include column names (CSV / TSV)</label>
      <label class="flex items-center gap-2">CSV delimiter <input id="delim" class="${field} w-14" maxlength="1" value=","/></label>
      <div class="text-muted">Source</div>
      <pre class="mono text-[11px] bg-panel rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap select-text">${esc(sql)}</pre>
      <div class="flex justify-end gap-2"><button id="x" class="px-3 py-1 rounded hover:bg-raised2">Close</button>
      <button id="go" class="px-3 py-1 rounded btn-primary">Export…</button></div>
    </div>`);
  m.q("#x").onclick = m.close;
  m.q("#go").onclick = async () => {
    const format = (m.o.querySelector('input[name="fmt"]:checked') as HTMLInputElement).value as ExportFormat;
    const path = await save({ defaultPath: `${suggestedName}.${EXT[format]}`, filters: [{ name: format.toUpperCase(), extensions: [EXT[format]] }] });
    if (!path) return;
    const job = jobSeq++;
    try {
      const n = await withProgress(m, job, "Exporting…", () =>
        api.exportData(connId, sql, path, { format, header: m.q<HTMLInputElement>("#hdr").checked, delimiter: m.q<HTMLInputElement>("#delim").value || ",", table: suggestedName }, job));
      status(`Exported ${n.toLocaleString()} rows to ${path}`);
    } catch (e) {
      status(String(e).includes("cancelled") ? "Export cancelled" : "Export failed: " + e);
    }
    m.close();
  };
}

/** Import dialog: pick a file, preview it, map columns, load into an existing or new table. */
export async function showImport(connId: number, objects: ObjectRef[], currentTable: string | undefined, columnsOf: (t: ObjectRef) => Promise<string[]>, done: (msg: string) => void) {
  const path = await open({ multiple: false, filters: [{ name: "Data", extensions: ["csv", "tsv", "txt", "json", "jsonl", "ndjson"] }, { name: "All", extensions: ["*"] }] });
  if (typeof path !== "string") return;
  let header = true;
  let prev: ImportPreview;
  try { prev = await api.importPreview(path, header); } catch (e) { done("Cannot read file: " + e); return; }

  const m = modal(`
    <div class="px-4 py-2 border-b border-line-strong font-semibold">Import <span class="font-normal text-soft mono text-[11px]">${esc(path.split("/").pop()!)}</span></div>
    <div id="body" class="p-4 flex flex-col gap-3 text-[12.5px] overflow-auto">
      <div class="flex gap-4 items-center flex-wrap">
        <label class="flex items-center gap-1"><input type="checkbox" id="hdr" checked/> First row is a header</label>
        <label class="flex items-center gap-1"><input type="checkbox" id="empty" checked/> Empty values → NULL</label>
        <label class="flex items-center gap-1">Delimiter <input id="delim" class="${field} w-12" maxlength="1"/></label>
      </div>
      <div class="flex gap-2 items-center">Into
        <select id="target" class="${field} flex-1"></select>
      </div>
      <div id="newname" class="hidden"><input id="nn" class="${field} w-full" placeholder="New table name"/></div>
      <div id="map" class="overflow-auto max-h-72 border border-line-strong rounded"></div>
      <div id="msg" class="text-danger min-h-4"></div>
      <div class="flex justify-end gap-2"><button id="x" class="px-3 py-1 rounded hover:bg-raised2">Cancel</button>
      <button id="go" class="px-3 py-1 rounded btn-primary">Import</button></div>
    </div>`, 720);
  const tables = objects.filter((o) => o.kind === "table");
  const sel = m.q<HTMLSelectElement>("#target");
  sel.innerHTML = `<option value="__new">＋ New table from this file</option>` + tables.map((t, i) => `<option value="${i}">${esc((t.schema && t.schema !== "public" ? t.schema + "." : "") + t.name)}</option>`).join("");
  const preSel = tables.findIndex((t) => t.name === currentTable);
  if (preSel >= 0) sel.value = String(preSel);
  m.q<HTMLInputElement>("#nn").value = (path.split("/").pop() ?? "import").replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]+/g, "_").toLowerCase();
  m.q<HTMLInputElement>("#delim").value = prev.format === "delimited" ? prev.delimiter : "";
  m.q<HTMLInputElement>("#delim").disabled = prev.format !== "delimited";

  let targetCols: string[] = [];
  const mapping: (string | null)[] = [];
  const renderMap = () => {
    const creating = sel.value === "__new";
    m.q("#newname").classList.toggle("hidden", !creating);
    const opts = (cur: string | null) => `<option value="">— skip —</option>` + targetCols.map((c) => `<option ${c === cur ? "selected" : ""}>${esc(c)}</option>`).join("");
    m.q("#map").innerHTML = `<table class="w-full text-[12px]"><thead class="bg-panel text-soft"><tr><th class="text-left px-2 py-1">File column</th><th class="text-left px-2">Sample</th><th class="text-left px-2">${creating ? "New column name" : "Table column"}</th></tr></thead><tbody>` +
      prev.headers.map((h, i) => `<tr class="border-t border-line"><td class="px-2 py-1 mono">${esc(h)} <span class="text-muted">${prev.types[i] ?? ""}</span></td>
        <td class="px-2 text-soft mono truncate max-w-48">${esc((prev.sample.slice(0, 3).map((r) => r[i] ?? "NULL")).join(" · "))}</td>
        <td class="px-2">${creating ? `<input data-i="${i}" value="${esc(mapping[i] ?? h)}" class="${field} w-full"/>` : `<select data-i="${i}" class="${field} w-full">${opts(mapping[i] ?? null)}</select>`}</td></tr>`).join("") + "</tbody></table>";
    m.o.querySelectorAll<HTMLInputElement | HTMLSelectElement>("#map [data-i]").forEach((el) => {
      mapping[+el.dataset.i!] = el.value || null;
      el.onchange = el.oninput = () => { mapping[+el.dataset.i!] = el.value || null; };
    });
  };
  const loadTarget = async () => {
    mapping.length = 0;
    if (sel.value !== "__new") {
      targetCols = await columnsOf(tables[+sel.value]);
      const lower = new Map(targetCols.map((c) => [c.toLowerCase(), c]));
      prev.headers.forEach((h, i) => { mapping[i] = lower.get(h.toLowerCase()) ?? null; });
    } else prev.headers.forEach((h, i) => { mapping[i] = h.trim() || `column${i + 1}`; });
    renderMap();
  };
  sel.onchange = loadTarget;
  const reparse = async () => {
    header = m.q<HTMLInputElement>("#hdr").checked;
    const d = m.q<HTMLInputElement>("#delim").value || undefined;
    try { prev = await api.importPreview(path, header, d); m.q("#msg").textContent = ""; await loadTarget(); } catch (e) { m.q("#msg").textContent = String(e); }
  };
  m.q("#hdr").onchange = reparse;
  m.q("#delim").onchange = reparse;
  m.q("#x").onclick = m.close;
  m.q("#go").onclick = async () => {
    const creating = sel.value === "__new";
    const t = creating ? null : tables[+sel.value];
    const name = creating ? m.q<HTMLInputElement>("#nn").value.trim() : t!.name;
    if (!name) { m.q("#msg").textContent = "Enter a table name"; return; }
    if (!mapping.some(Boolean)) { m.q("#msg").textContent = "Map at least one column"; return; }
    const job = jobSeq++;
    try {
      const r = await withProgress(m, job, "Importing…", () => api.importData(connId, path, {
        schema: t?.schema ?? null, table: name, create: creating, has_header: header,
        delimiter: m.q<HTMLInputElement>("#delim").value || undefined, mapping: [...mapping], empty_as_null: m.q<HTMLInputElement>("#empty").checked,
      }, job));
      done(`Imported ${r.rows.toLocaleString()} rows into ${name}`);
    } catch (e) {
      done(String(e).includes("cancelled") ? "Import cancelled" : "Import failed: " + e);
    }
    m.close();
  };
  await loadTarget();
}
