import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { api, type ExportFormat, type ImportPreview, type ObjectRef } from "./api";
import { icon } from "./icons";
import { esc, modal } from "./ui";

let jobSeq = 1;

const head = (ic: string, title: string, sub: string) => `
  <div class="flex items-start gap-3.5 px-6 pt-5 pb-4">
    <span class="grid place-items-center shrink-0 rounded-xl" style="width:42px;height:42px;background:var(--accent-soft);color:var(--accent)">${icon(ic, 21)}</span>
    <div class="min-w-0"><div class="text-[17px] font-semibold leading-tight truncate">${title}</div><div class="text-soft mt-0.5">${sub}</div></div>
  </div>`;

/** Run a job while showing live row counts and speed; `Cancel` stops it in Rust. */
async function withProgress<T>(m: ReturnType<typeof modal>, job: number, label: string, noun: string, run: () => Promise<T>): Promise<T> {
  m.q("#body").innerHTML = `<div class="px-8 pt-3 pb-7 text-center">
      <div class="text-soft mb-1">${esc(label)}</div>
      <div id="count" class="text-[34px] font-semibold tracking-tight" style="font-variant-numeric:tabular-nums">0</div>
      <div id="rate" class="text-muted mb-5">${esc(noun)}</div>
      <div class="relative h-1.5 rounded-full overflow-hidden mx-4 mb-6" style="background:var(--raised)"><div class="running-bar" style="height:6px"></div></div>
      <button id="cancel" class="btn">Cancel</button></div>`;
  const started = performance.now();
  const un = await listen<{ job: number; rows: number }>("io-progress", (e) => {
    if (e.payload.job !== job) return;
    const secs = (performance.now() - started) / 1000;
    m.q("#count").textContent = e.payload.rows.toLocaleString();
    m.q("#rate").textContent = `${noun}${secs > 0.4 ? ` · ${Math.round(e.payload.rows / secs).toLocaleString()} per second` : ""}`;
  });
  m.q("#cancel").onclick = () => { api.cancelIo(job); m.q("#cancel").textContent = "Cancelling…"; };
  try { return await run(); } finally { un(); }
}

const EXT: Record<ExportFormat, string> = { csv: "csv", tsv: "tsv", json: "json", jsonl: "jsonl", sql: "sql" };
const FORMATS: [ExportFormat, string, string][] = [["csv", "CSV", "Spreadsheets"], ["tsv", "TSV", "Tab-separated"], ["json", "JSON", "One array"], ["jsonl", "JSON Lines", "One per line"], ["sql", "SQL", "INSERT statements"]];

/** Export dialog. `sql` is run in full (no row cap) and streamed to the chosen file. */
export function showExport(connId: number, sql: string, suggestedName: string, status: (s: string) => void, many?: { name: string; sql: string }[]) {
  const m = modal(`
    ${head("download", many ? `Export ${many.length} tables` : `Export ${esc(suggestedName)}`, many ? "One file per table, written to a folder you choose. There is no row limit." : "Streams straight from the database to a file. There is no row limit.")}
    <div id="body" class="px-6 pb-5 flex flex-col gap-4 overflow-auto">
      <div>
        <div class="font-medium mb-2">Format</div>
        <div id="fmts" class="grid gap-2" style="grid-template-columns:repeat(5,1fr)">
          ${FORMATS.map(([f, label, hint], i) => `<label data-card="${f}" class="cursor-default rounded-xl px-2.5 py-2.5 text-center" style="background:var(--panel)">
            <input type="radio" name="fmt" value="${f}" class="sr-only" ${i === 0 ? "checked" : ""}/><div class="font-semibold">${label}</div><div class="text-[12px] text-muted">${hint}</div></label>`).join("")}
        </div>
      </div>
      <div class="flex items-center gap-6 flex-wrap">
        <label class="flex items-center gap-2"><input type="checkbox" id="hdr" checked/> Include column names</label>
        <label class="flex items-center gap-2">Delimiter <input id="delim" class="field text-center mono" style="width:48px" maxlength="1" value=","/></label>
      </div>
      <div>
        <div class="font-medium mb-1.5">What will be exported</div>
        <pre class="mono text-[12.5px] rounded-xl px-3.5 py-3 max-h-28 overflow-auto whitespace-pre-wrap select-text" style="background:var(--canvas);color:var(--soft)">${esc(many ? many.map((t) => t.name).join("\n") : sql)}</pre>
      </div>
      <div class="flex items-center justify-end gap-2 pt-1"><button id="x" class="btn btn-ghost">Close</button><button id="go" class="btn btn-primary">${icon("download", 15)}<span>Export…</span></button></div>
    </div>`, 620);
  const paintCards = () => m.o.querySelectorAll<HTMLElement>("[data-card]").forEach((c) => {
    const on = (c.querySelector("input") as HTMLInputElement).checked;
    c.style.boxShadow = on ? "inset 0 0 0 2px var(--accent)" : "inset 0 0 0 1px var(--line-strong)";
    c.style.background = on ? "var(--accent-soft)" : "var(--panel)";
    m.q<HTMLInputElement>("#delim").disabled = (m.o.querySelector('input[name="fmt"]:checked') as HTMLInputElement).value !== "csv";
    m.q<HTMLInputElement>("#hdr").disabled = !["csv", "tsv"].includes((m.o.querySelector('input[name="fmt"]:checked') as HTMLInputElement).value);
  });
  m.o.querySelectorAll<HTMLInputElement>('input[name="fmt"]').forEach((r) => (r.onchange = paintCards));
  paintCards();
  m.q("#x").onclick = m.close;
  m.q("#go").onclick = async () => {
    const format = (m.o.querySelector('input[name="fmt"]:checked') as HTMLInputElement).value as ExportFormat;
    if (many) return exportMany(m, connId, many, format, status);
    const path = await save({ defaultPath: `${suggestedName}.${EXT[format]}`, filters: [{ name: format.toUpperCase(), extensions: [EXT[format]] }] });
    if (!path) return;
    const job = jobSeq++;
    // Read every option NOW: the progress view below replaces the form.
    const options = { format, header: m.q<HTMLInputElement>("#hdr").checked, delimiter: m.q<HTMLInputElement>("#delim").value || ",", table: suggestedName };
    try {
      const n = await withProgress(m, job, `Exporting ${suggestedName} as ${format.toUpperCase()}…`, "rows written", () => api.exportData(connId, sql, path, options, job));
      status(`Exported ${n.toLocaleString()} rows to ${path}`);
    } catch (e) {
      status(String(e).includes("cancelled") ? "Export cancelled" : "Export failed: " + e);
    }
    m.close();
  };
}

/** Write each table to its own file in a chosen folder. A failing table doesn't stop the rest; Cancel does. */
async function exportMany(m: ReturnType<typeof modal>, connId: number, tables: { name: string; sql: string }[], format: ExportFormat, status: (s: string) => void) {
  const dir = await open({ directory: true, title: "Choose a folder for the exported files" });
  if (typeof dir !== "string") return;
  const options = { format, header: m.q<HTMLInputElement>("#hdr").checked, delimiter: m.q<HTMLInputElement>("#delim").value || ",", table: "" };
  const used = new Set<string>(), failed: string[] = [];
  let rows = 0, done = 0, cancelled = false;
  for (const [i, t] of tables.entries()) {
    let file = t.name.replace(/[\\/:*?"<>|]/g, "_") || "table";
    for (let n = 2; used.has(file.toLowerCase()); n++) file = `${t.name}_${n}`;
    used.add(file.toLowerCase());
    const job = jobSeq++;
    try {
      rows += await withProgress(m, job, `Exporting ${t.name} (${i + 1} of ${tables.length})…`, "rows written", () => api.exportData(connId, t.sql, `${dir}/${file}.${EXT[format]}`, { ...options, table: t.name }, job));
      done++;
    } catch (e) {
      if (String(e).includes("cancelled")) { cancelled = true; break; }
      failed.push(`${t.name}: ${e}`);
    }
  }
  m.close();
  const base = `Exported ${done} of ${tables.length} tables (${rows.toLocaleString()} rows) to ${dir}`;
  status(cancelled ? `Export cancelled after ${done} of ${tables.length} tables` : failed.length ? `${base}. Failed: ${failed.join("; ")}` : base);
}

/** Import dialog: pick a file, preview it, map columns, load into an existing or new table. */
export async function showImport(connId: number, objects: ObjectRef[], currentTable: string | undefined, columnsOf: (t: ObjectRef) => Promise<string[]>, done: (msg: string) => void) {
  const path = await open({ multiple: false, filters: [{ name: "Data", extensions: ["csv", "tsv", "txt", "json", "jsonl", "ndjson"] }, { name: "All", extensions: ["*"] }] });
  if (typeof path !== "string") return;
  let header = true;
  let prev: ImportPreview;
  try { prev = await api.importPreview(path, header); } catch (e) { done("Cannot read file: " + e); return; }
  const file = path.split("/").pop()!;
  const kindLabel = () => (prev.format === "delimited" ? ({ ",": "CSV", ";": "Semicolon-separated", "\t": "TSV", "|": "Pipe-separated" } as Record<string, string>)[prev.delimiter] ?? "Delimited text" : prev.format === "jsonl" ? "JSON Lines" : "JSON");

  const m = modal(`
    ${head("upload", "Import a file", `<span class="mono text-[12.5px]">${esc(file)}</span>`)}
    <div id="body" class="px-6 pb-5 flex flex-col gap-4 overflow-auto">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="pill" id="kind"></span><span class="pill" id="cols"></span>
        <span class="flex-1"></span>
        <label class="flex items-center gap-2"><input type="checkbox" id="hdr" checked/> First row is a header</label>
        <label class="flex items-center gap-2"><input type="checkbox" id="empty" checked/> Empty means NULL</label>
        <label class="flex items-center gap-2">Delimiter <input id="delim" class="field text-center mono" style="width:44px" maxlength="1"/></label>
      </div>
      <div>
        <div class="font-medium mb-2">Load into</div>
        <div class="flex gap-2 items-center">
          <div class="seg shrink-0"><button type="button" id="m-new" aria-pressed="true">New table</button><button type="button" id="m-old" aria-pressed="false">Existing table</button></div>
          <input id="nn" class="field flex-1" placeholder="New table name"/>
          <select id="target" class="field flex-1 hidden"></select>
        </div>
      </div>
      <div>
        <div class="font-medium mb-2">Match columns <span class="text-muted font-normal">· the first rows of your file are shown as a sample</span></div>
        <div id="map" class="overflow-auto max-h-72 rounded-xl" style="box-shadow:inset 0 0 0 1px var(--line-strong)"></div>
      </div>
      <div id="msg" class="text-danger min-h-4"></div>
      <div class="flex items-center justify-end gap-2"><button id="x" class="btn btn-ghost">Cancel</button><button id="go" class="btn btn-primary">${icon("upload", 15)}<span>Import</span></button></div>
    </div>`, 760);
  const tables = objects.filter((o) => o.kind === "table");
  const sel = m.q<HTMLSelectElement>("#target");
  sel.innerHTML = tables.map((t, i) => `<option value="${i}">${esc((t.schema && t.schema !== "public" ? t.schema + "." : "") + t.name)}</option>`).join("");
  const preSel = tables.findIndex((t) => t.name === currentTable);
  if (preSel >= 0) sel.value = String(preSel);
  m.q<HTMLInputElement>("#nn").value = file.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]+/g, "_").toLowerCase();
  let creating = true;
  const paintHeaderInfo = () => {
    m.q("#kind").textContent = kindLabel();
    m.q("#cols").textContent = `${prev.headers.length} columns`;
    m.q<HTMLInputElement>("#delim").value = prev.format === "delimited" ? prev.delimiter : "";
    m.q<HTMLInputElement>("#delim").disabled = prev.format !== "delimited";
  };
  paintHeaderInfo();

  let targetCols: string[] = [];
  const mapping: (string | null)[] = [];
  const renderMap = () => {
    m.q("#nn").classList.toggle("hidden", !creating);
    sel.classList.toggle("hidden", creating);
    m.q("#m-new").setAttribute("aria-pressed", String(creating));
    m.q("#m-old").setAttribute("aria-pressed", String(!creating));
    const opts = (cur: string | null) => `<option value="">Skip this column</option>` + targetCols.map((c) => `<option ${c === cur ? "selected" : ""}>${esc(c)}</option>`).join("");
    const typeBadge = (t: string) => `<span class="mono text-[11px] rounded px-1.5 py-0.5" style="background:var(--raised);color:${t === "integer" || t === "real" ? "var(--num)" : "var(--soft)"}">${t}</span>`;
    m.q("#map").innerHTML = `<table class="w-full"><thead><tr style="background:var(--grid-head)"><th class="text-left font-semibold text-soft px-3 h-9">In your file</th><th class="text-left font-semibold text-soft px-2">Sample</th><th class="text-left font-semibold text-soft px-2">${creating ? "New column name" : "Goes into"}</th></tr></thead><tbody>` +
      prev.headers.map((h, i) => `<tr style="border-top:1px solid var(--line)"><td class="px-3 h-10 whitespace-nowrap"><span class="font-medium">${esc(h)}</span> ${typeBadge(prev.types[i] ?? "text")}</td>
        <td class="px-2 text-soft mono text-[12.5px] max-w-[220px]"><div class="truncate">${esc(prev.sample.slice(0, 3).map((r) => r[i] ?? "null").join("  ·  "))}</div></td>
        <td class="px-2 py-1" style="width:200px">${creating ? `<input data-i="${i}" value="${esc(mapping[i] ?? h)}" class="field w-full"/>` : `<select data-i="${i}" class="field w-full">${opts(mapping[i] ?? null)}</select>`}</td></tr>`).join("") + "</tbody></table>";
    m.o.querySelectorAll<HTMLInputElement | HTMLSelectElement>("#map [data-i]").forEach((el) => {
      mapping[+el.dataset.i!] = el.value || null;
      el.onchange = el.oninput = () => { mapping[+el.dataset.i!] = el.value || null; };
    });
  };
  const loadTarget = async () => {
    mapping.length = 0;
    if (!creating && tables.length) {
      targetCols = await columnsOf(tables[+sel.value]);
      const lower = new Map(targetCols.map((c) => [c.toLowerCase(), c]));
      prev.headers.forEach((h, i) => { mapping[i] = lower.get(h.toLowerCase()) ?? null; });
    } else prev.headers.forEach((h, i) => { mapping[i] = h.trim() || `column${i + 1}`; });
    renderMap();
  };
  sel.onchange = loadTarget;
  m.q("#m-new").onclick = () => { creating = true; loadTarget(); };
  m.q("#m-old").onclick = () => { if (!tables.length) { m.q("#msg").textContent = "This database has no tables yet. Import into a new table."; return; } creating = false; loadTarget(); };
  const reparse = async () => {
    header = m.q<HTMLInputElement>("#hdr").checked;
    const d = m.q<HTMLInputElement>("#delim").value || undefined;
    try { prev = await api.importPreview(path, header, d); m.q("#msg").textContent = ""; paintHeaderInfo(); await loadTarget(); } catch (e) { m.q("#msg").textContent = String(e); }
  };
  m.q("#hdr").onchange = reparse;
  m.q("#delim").onchange = reparse;
  m.q("#x").onclick = m.close;
  m.q("#go").onclick = async () => {
    const t = creating ? null : tables[+sel.value];
    const name = creating ? m.q<HTMLInputElement>("#nn").value.trim() : t!.name;
    if (!name) { m.q("#msg").textContent = "Enter a name for the new table."; return; }
    if (!mapping.some(Boolean)) { m.q("#msg").textContent = "Match at least one column."; return; }
    const job = jobSeq++;
    // Read every option NOW: the progress view below replaces the form.
    const options = {
      schema: t?.schema ?? null, table: name, create: creating, has_header: header,
      delimiter: m.q<HTMLInputElement>("#delim").value || undefined, mapping: [...mapping], empty_as_null: m.q<HTMLInputElement>("#empty").checked,
    };
    try {
      const r = await withProgress(m, job, `Importing into ${name}…`, "rows inserted", () => api.importData(connId, path, options, job));
      done(`Imported ${r.rows.toLocaleString()} rows into ${name}`);
    } catch (e) {
      done(String(e).includes("cancelled") ? "Import cancelled" : "Import failed: " + e);
    }
    m.close();
  };
  await loadTarget();
}
