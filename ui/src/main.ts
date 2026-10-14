import "./style.css";
import { open } from "@tauri-apps/plugin-dialog";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { autocompletion, completionKeymap, pickedCompletion } from "@codemirror/autocomplete";
import { lintSql, lintPlan } from "./lint";
import { renderPlan, hintsPanel } from "./planview";
import { makeCompletionSource, recordAccepted } from "./complete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql, SQLite, PostgreSQL, MySQL } from "@codemirror/lang-sql";
import { api, type ObjectRef, type Summary, type Profile, type SchemaTable, type ColumnInfo, type Change, type Val } from "./api";
import { showConnectionManager } from "./connections";
import { Grid } from "./grid";

interface Conn { id: number; name: string; kind: string; objects: ObjectRef[]; schema: SchemaTable[] }
interface Tab {
  id: number; title: string; kind: "query" | "table";
  conn: Conn | null; table?: string;
  root: HTMLElement; grid: Grid; panel?: HTMLElement; gridWrap?: HTMLElement; cols?: ColumnInfo[]; schemaName?: string | null; bar?: HTMLElement; editor?: EditorView; status: HTMLElement;
}

let conn: Conn | null = null;
const tabs: Tab[] = [];
let active: Tab | null = null;
let tabSeq = 0;
const sqlLang = new Compartment();

function langFor(c: Conn | null) {
  const dialect = c?.kind === "sqlite" ? SQLite : c && ["mysql", "mariadb"].includes(c.kind) ? MySQL : PostgreSQL;
  return sql({ dialect, upperCaseKeywords: true });
}

async function formatEditor(view: EditorView, c: Conn | null) {
  // Loaded on first use to keep startup memory small.
  const { format: formatSql } = await import("sql-formatter");
  const language = c?.kind === "sqlite" ? "sqlite" : c && ["mysql", "mariadb"].includes(c.kind) ? "mysql" : "postgresql";
  const sel = view.state.selection.main;
  const [from, to] = sel.empty ? [0, view.state.doc.length] : [sel.from, sel.to];
  try {
    const out = formatSql(view.state.sliceDoc(from, to), { language, keywordCase: "upper" });
    view.dispatch({ changes: { from, to, insert: out } });
  } catch { /* leave text untouched when the SQL cannot be parsed */ }
}

const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="titlebar h-10 shrink-0 bg-zinc-950 border-b border-zinc-800 flex items-end pl-20 pr-2 gap-1">
    <div id="tabs" class="flex items-end gap-1 overflow-x-auto flex-1"></div>
    <button id="newtab" class="mb-1 px-2 text-lg text-zinc-400 hover:text-white" title="New tab (⌘T)">+</button>
  </div>
  <div class="flex-1 flex min-h-0">
    <aside class="w-60 shrink-0 bg-zinc-950 border-r border-zinc-800 flex flex-col">
      <div class="p-2 flex gap-2">
        <button id="open" class="flex-1 bg-zinc-800 hover:bg-zinc-700 rounded px-2 py-1">Connections… <span class="text-zinc-500">⌘O</span></button>
      </div>
      <input id="filter" placeholder="Search for item…" class="mx-2 mb-2 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 outline-none focus:border-blue-600"/>
      <div id="objects" class="flex-1 overflow-auto px-1 text-[12.5px]"></div>
      <div id="connname" class="p-2 text-[11px] text-zinc-500 border-t border-zinc-800">Not connected</div>
    </aside>
    <main id="main" class="flex-1 min-w-0 flex flex-col"></main>
  </div>
  <div id="palette" class="hidden fixed inset-0 bg-black/40 flex items-start justify-center pt-24 z-50">
    <div class="w-[520px] bg-zinc-800 rounded-lg shadow-2xl border border-zinc-700 overflow-hidden">
      <input id="pinput" placeholder="Open quickly…" class="w-full bg-zinc-800 px-3 py-2 outline-none border-b border-zinc-700"/>
      <div id="plist" class="max-h-72 overflow-auto"></div>
    </div>
  </div>`;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function makeTab(kind: Tab["kind"], title: string, table?: string): Tab {
  const root = document.createElement("div");
  root.className = "h-full flex flex-col min-h-0";
  const grid = new Grid();
  const status = document.createElement("div");
  status.className = "h-6 shrink-0 px-3 text-[11px] leading-6 text-zinc-500 bg-zinc-950 border-t border-zinc-800 mono";
  const tab: Tab = { id: ++tabSeq, title, kind, conn, table, root, grid, status };
  if (kind === "query") {
    const ed = document.createElement("div");
    ed.className = "h-1/3 min-h-[80px] border-b border-zinc-700 overflow-hidden";
    tab.editor = new EditorView({
      parent: ed,
      state: EditorState.create({
        doc: "",
        extensions: [
          lineNumbers(), history(), sqlLang.of(langFor(conn)),
          autocompletion({ override: [makeCompletionSource(() => tab.conn?.schema ?? [])], activateOnTyping: true, icons: false }),
          EditorView.updateListener.of((u) => { for (const tr of u.transactions) { const c = tr.annotation(pickedCompletion); if (c) recordAccepted(c.label); } }),
          keymap.of([
            { key: "Mod-Enter", run: () => (runActive(), true) },
            { key: "Mod-i", run: (v) => (formatEditor(v, tab.conn), true) },
            ...completionKeymap, ...defaultKeymap, ...historyKeymap,
          ]),
        ],
      }),
    });
    root.append(ed);
  }
  const gridWrap = document.createElement("div");
  gridWrap.className = "flex-1 min-h-0";
  gridWrap.append(grid.el);
  tab.gridWrap = gridWrap;
  if (kind === "table") {
    const bar = document.createElement("div");
    bar.className = "h-8 shrink-0 flex items-center gap-2 px-2 bg-zinc-950 border-b border-zinc-800 text-[12px]";
    const btn = (label: string, title: string, f: () => void) => {
      const b = document.createElement("button");
      b.textContent = label; b.title = title;
      b.className = "px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:hover:bg-zinc-800";
      b.onclick = f;
      return b;
    };
    const commit = btn("Commit", "Review & commit changes (⌘S)", () => commitChanges(tab));
    const discard = btn("Discard", "Discard pending changes", () => grid.discard());
    commit.id = "commit"; discard.id = "discard";
    const info = document.createElement("span");
    info.className = "text-zinc-500 ml-2";
    bar.append(btn("+ Row", "Insert row (⌘I)", () => grid.addRow()), btn("− Row", "Delete selected row (⌘⌫)", () => grid.deleteSelected()), commit, discard, info);
    const refreshBar = () => {
      const n = grid.pendingCount;
      commit.toggleAttribute("disabled", n === 0);
      discard.toggleAttribute("disabled", n === 0);
      info.textContent = !tab.cols ? "" : grid.editable ? (n ? `${n} pending change${n > 1 ? "s" : ""}` : "Double-click a cell to edit") : "Read-only (no primary key)";
    };
    grid.onChange = refreshBar;
    refreshBar();
    tab.bar = bar;
    root.append(bar);
  }
  root.append(gridWrap, status);
  tabs.push(tab);
  activate(tab);
  tab.editor?.focus();
  return tab;
}

function activate(t: Tab) {
  active = t;
  const main = $("main");
  main.replaceChildren(t.root);
  renderTabs();
}

function closeTab(t: Tab) {
  const i = tabs.indexOf(t);
  if (i < 0) return;
  tabs.splice(i, 1);
  t.grid.setResult(null);
  t.editor?.destroy();
  if (active === t) {
    const next = tabs[Math.min(i, tabs.length - 1)];
    if (next) activate(next);
    else { active = null; $("main").replaceChildren(); renderTabs(); }
  } else renderTabs();
}

function renderTabs() {
  const el = $("tabs");
  el.replaceChildren(
    ...tabs.map((t, i) => {
      const d = document.createElement("div");
      d.className = "group flex items-center gap-2 px-3 py-1.5 rounded-t-md cursor-default text-[12px] max-w-48 " +
        (t === active ? "bg-zinc-900 text-white" : "text-zinc-400 hover:bg-zinc-900/60");
      d.title = `${t.title}  (⌘${i < 9 ? i + 1 : ""})`;
      const label = document.createElement("span");
      label.className = "truncate";
      label.textContent = t.title;
      const x = document.createElement("button");
      x.textContent = "×";
      x.className = "text-zinc-500 hover:text-white opacity-0 group-hover:opacity-100";
      x.onclick = (e) => { e.stopPropagation(); closeTab(t); };
      d.append(label, x);
      d.onclick = () => activate(t);
      d.onauxclick = () => closeTab(t);
      return d;
    }),
  );
}

async function exec(t: Tab, sqlText: string) {
  if (!t.conn) { t.status.textContent = "Not connected — open a database first (⌘O)"; return; }
  if (t.panel && t.gridWrap) { t.gridWrap.replaceChildren(t.grid.el); t.panel = undefined; }
  t.status.textContent = "Running…";
  try {
    const s: Summary = await api.runQuery(t.conn.id, sqlText);
    await t.grid.setResult(s.columns.length ? s : null);
    t.status.textContent = s.columns.length
      ? `${s.row_count.toLocaleString()} rows${s.truncated ? " (truncated)" : ""} · ${s.elapsed_ms} ms`
      : `${s.affected ?? 0} rows affected · ${s.elapsed_ms} ms`;
    if (/^\s*(create|drop|alter)\b/i.test(sqlText)) refreshObjects();
  } catch (e) {
    await t.grid.setResult(null);
    t.status.textContent = "Error: " + e;
    t.status.classList.add("text-red-400");
    return;
  }
  t.status.classList.remove("text-red-400");
}

const orig = (g: Grid, r: number, i: number): Val => g.original(r)?.[i] ?? { t: "Null" };

function buildChanges(t: Tab): Change[] | string {
  const g = t.grid, cols = t.cols!;
  const pk = cols.map((c, i) => [c, i] as const).filter(([c]) => c.primary_key);
  const colIdx = (name: string) => g.columns.findIndex((c) => c.name === name);
  const numeric = (type: string) => /int|serial|numeric|decimal|real|float|double|number/i.test(type);
  const typed = (name: string, v: Val): Val => {
    const c = cols.find((x) => x.name === name);
    if (v.t === "Text" && c && numeric(c.type_name) && v.v.trim() !== "" && !isNaN(Number(v.v))) {
      return /^-?\d+$/.test(v.v.trim()) ? { t: "I64", v: Number(v.v) } : { t: "F64", v: Number(v.v) };
    }
    return v;
  };
  const key = (r: number): [string, Val][] => pk.map(([c]) => [c.name, orig(g, r, colIdx(c.name))] as [string, Val]);
  const out: Change[] = [];
  for (const [r, m] of g.edits) {
    if (g.deleted.has(r)) continue;
    if (!g.original(r)) return "Edited rows must be loaded; scroll to them and try again.";
    out.push({ kind: "update", key: key(r), set: [...m].map(([i, v]) => [g.columns[i].name, typed(g.columns[i].name, v)] as [string, Val]) });
  }
  for (const r of g.deleted) {
    if (!g.original(r)) return "Deleted rows must be loaded; scroll to them and try again.";
    out.push({ kind: "delete", key: key(r) });
  }
  const n = g.columns.length;
  g.inserted.forEach((row) => out.push({ kind: "insert", set: row.map((v, i) => [g.columns[i].name, typed(g.columns[i].name, v)] as [string, Val]).filter(([, v]) => v.t !== "Null") }));
  void n;
  return out;
}

/** Show the generated SQL and, on confirmation, run it in one transaction. */
async function commitChanges(t: Tab) {
  if (!t.conn || !t.table || !t.cols) return;
  const changes = buildChanges(t);
  if (typeof changes === "string") { t.status.textContent = changes; return; }
  try {
    const stmts = await api.applyChanges(t.conn.id, t.schemaName ?? null, t.table, changes, true);
    if (!(await confirmSql(stmts))) return;
    await api.applyChanges(t.conn.id, t.schemaName ?? null, t.table, changes, false);
    t.grid.discard(); // staged changes are now in the database
    reload(t);
  } catch (e) {
    t.status.textContent = "Commit failed: " + e;
    t.status.classList.add("text-red-400");
  }
}

function confirmSql(stmts: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const o = document.createElement("div");
    o.className = "fixed inset-0 bg-black/50 flex items-center justify-center z-50";
    o.innerHTML = `<div class="w-[640px] max-h-[70vh] bg-zinc-800 rounded-lg border border-zinc-700 shadow-2xl flex flex-col">
      <div class="px-4 py-2 border-b border-zinc-700 font-semibold">Review changes (${stmts.length} statement${stmts.length > 1 ? "s" : ""}, one transaction)</div>
      <pre class="mono text-[12px] p-4 overflow-auto flex-1 select-text whitespace-pre-wrap"></pre>
      <div class="p-3 flex justify-end gap-2 border-t border-zinc-700">
        <button id="no" class="px-3 py-1 rounded hover:bg-zinc-700">Cancel</button>
        <button id="yes" class="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500">Commit</button></div></div>`;
    o.querySelector("pre")!.textContent = stmts.join("\n");
    const done = (v: boolean) => { o.remove(); window.removeEventListener("keydown", key, true); resolve(v); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") done(false); else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) done(true); };
    window.addEventListener("keydown", key, true);
    (o.querySelector("#no") as HTMLElement).onclick = () => done(false);
    (o.querySelector("#yes") as HTMLElement).onclick = () => done(true);
    document.body.append(o);
    (o.querySelector("#yes") as HTMLElement).focus();
  });
}

function currentSql(t: Tab): string {
  const view = t.editor!;
  const sel = view.state.selection.main;
  if (!sel.empty) return view.state.sliceDoc(sel.from, sel.to);
  // Statement under the cursor (split on ;), falling back to the whole editor.
  const doc = view.state.doc.toString();
  const start = doc.lastIndexOf(";", Math.max(0, sel.head - 1)) + 1;
  const end = doc.indexOf(";", sel.head);
  const stmt = doc.slice(start, end < 0 ? doc.length : end).trim();
  return stmt || doc.trim();
}

/** ⌘E: show the query plan with optimizer suggestions; ⌘⇧E also runs the query (EXPLAIN ANALYZE). */
async function explainActive(analyze: boolean) {
  const t = active;
  if (!t || t.kind !== "query" || !t.gridWrap) return;
  const sqlText = currentSql(t);
  if (!sqlText) return;
  const hints = lintSql(sqlText);
  const show = (el: HTMLElement) => {
    t.panel = el;
    t.gridWrap!.replaceChildren(el);
  };
  if (!t.conn) return show(hintsPanel(hints));
  t.status.textContent = analyze ? "Analyzing…" : "Explaining…";
  try {
    const plan = await api.explain(t.conn.id, sqlText, analyze);
    show(renderPlan(plan, [...hints, ...lintPlan(plan)]));
    t.status.textContent = "Query plan — press ⌘Enter to return to results";
  } catch (e) {
    show(hintsPanel(hints));
    t.status.textContent = "Explain failed: " + e;
  }
}

function runActive() {
  const t = active;
  if (!t) return;
  if (t.kind === "table") return reload(t);
  const view = t.editor!;
  const sel = view.state.selection.main;
  const text = sel.empty ? view.state.doc.toString() : view.state.sliceDoc(sel.from, sel.to);
  if (text.trim()) exec(t, text);
}

function reload(t: Tab) {
  if (t.kind === "table" && t.table && t.conn) {
    const o = t.conn.objects.find((x) => x.name === t.table);
    t.schemaName = o?.schema ?? null;
    if (t.grid.pendingCount) { t.status.textContent = "Commit (⌘S) or discard pending changes before reloading"; return; }
    api.describe(t.conn.id, t.schemaName, t.table)
      .then((d) => { t.cols = d.columns; t.grid.editable = o?.kind !== "view" && d.columns.some((c) => c.primary_key); })
      .catch(() => { t.grid.editable = false; })
      .then(() => api.selectAllSql(t.conn!.id, t.schemaName ?? null, t.table!))
      .then((q) => exec(t, q))
      .then(() => t.grid.onChange());
  } else runActive();
}

function openTable(name: string) {
  const existing = tabs.find((t) => t.kind === "table" && t.table === name && t.conn === conn);
  if (existing) return activate(existing);
  const t = makeTab("table", name, name);
  reload(t);
}

async function refreshObjects() {
  if (!conn) return;
  conn.objects = await api.listObjects(conn.id);
  renderObjects();
}

function renderObjects() {
  const q = $<HTMLInputElement>("filter").value.toLowerCase();
  $("objects").replaceChildren(
    ...(conn?.objects ?? []).filter((o) => o.name.toLowerCase().includes(q)).map((o) => {
      const d = document.createElement("div");
      d.className = "px-2 py-0.5 rounded hover:bg-zinc-800 cursor-default truncate";
      d.textContent = (o.kind === "view" ? "◇ " : "▦ ") + (o.schema && o.schema !== "public" ? o.schema + "." : "") + o.name;
      d.ondblclick = () => openTable(o.name);
      return d;
    }),
  );
}

async function useConnection(id: number, p: { name: string; kind: string }) {
  const c: Conn = { id, name: p.name, kind: p.kind, objects: [], schema: [] };
  conn = c;
  $("connname").textContent = p.name;
  await refreshObjects();
  api.schemaMap(id).then((m) => {
    c.schema = m;
    // Re-point every open query editor of this connection at the new schema.
    for (const t of tabs) t.editor && t.conn === c && t.editor.dispatch({ effects: sqlLang.reconfigure(langFor(c)) });
  }).catch(() => {});
  if (!tabs.length) makeTab("query", "Query");
}

function openConnections() {
  showConnectionManager(async (id, profile: Profile) => { await useConnection(id, profile); });
}

function palette() {
  const p = $("palette"), inp = $<HTMLInputElement>("pinput"), list = $("plist");
  p.classList.remove("hidden"); inp.value = ""; inp.focus();
  let idx = 0, items: ObjectRef[] = [];
  const draw = () => {
    const q = inp.value.toLowerCase();
    items = (conn?.objects ?? []).filter((o) => o.name.toLowerCase().includes(q)).slice(0, 50);
    idx = Math.min(idx, Math.max(0, items.length - 1));
    list.replaceChildren(...items.map((o, i) => {
      const d = document.createElement("div");
      d.className = "px-3 py-1.5 " + (i === idx ? "bg-blue-600" : "");
      d.textContent = o.name + "  ·  " + o.kind;
      d.onclick = () => choose(o);
      return d;
    }));
  };
  const close = () => { p.classList.add("hidden"); inp.oninput = inp.onkeydown = null; };
  const choose = (o: ObjectRef) => { close(); openTable(o.name); };
  inp.oninput = draw;
  inp.onkeydown = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") { idx = Math.min(idx + 1, items.length - 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { idx = Math.max(idx - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === "Enter" && items[idx]) choose(items[idx]);
  };
  draw();
}

// Keyboard shortcuts (TablePlus-style)
window.addEventListener("keydown", (e) => {
  if (!e.metaKey) return;
  const k = e.key.toLowerCase();
  const go = (f: () => void) => { e.preventDefault(); f(); };
  if (k === "t") go(() => makeTab("query", "Query"));
  else if (k === "w") go(() => active && closeTab(active));
  else if (k === "o" || k === "n") go(openConnections);
  else if (k === "p") go(palette);
  else if (k === "r") go(() => active && reload(active));
  else if (k === "enter") go(runActive);
  else if (k === "e") go(() => explainActive(e.shiftKey));
  else if (k === "s" && active?.kind === "table") go(() => commitChanges(active!));
  else if (k === "i" && active?.kind === "table") go(() => active!.grid.addRow());
  else if (e.key === "Backspace" && active?.kind === "table" && !(e.target instanceof HTMLInputElement)) go(() => active!.grid.deleteSelected());
  else if (/^[1-9]$/.test(k)) go(() => tabs[+k - 1] && activate(tabs[+k - 1]));
  else if (e.shiftKey && (e.key === "]" || e.key === "}")) go(() => cycle(1));
  else if (e.shiftKey && (e.key === "[" || e.key === "{")) go(() => cycle(-1));
  else if (k === "l") go(() => $("filter").focus());
});

function cycle(d: number) {
  if (!active) return;
  activate(tabs[(tabs.indexOf(active) + d + tabs.length) % tabs.length]);
}

$("newtab").onclick = () => makeTab("query", "Query");
$("open").onclick = openConnections;
openConnections();
$("filter").oninput = renderObjects;
