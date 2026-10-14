import "./style.css";
import { installMock } from "./mock";
// Dev only: `?mock` renders the UI without the Rust backend. Stripped from production builds.
if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) installMock();
import { open } from "@tauri-apps/plugin-dialog";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { autocompletion, completionKeymap, pickedCompletion } from "@codemirror/autocomplete";
import { createBuilder } from "./builder";
import { showExport, showImport } from "./io";
import { createStructureView } from "./structure";
import { createFilterBar } from "./filterbar";
import { lintSql, lintPlan } from "./lint";
import { renderPlan, hintsPanel } from "./planview";
import { makeCompletionSource, recordAccepted } from "./complete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { sql, SQLite, PostgreSQL, MySQL, MSSQL } from "@codemirror/lang-sql";
import { api, type ObjectRef, type Summary, type Profile, type SchemaTable, type ColumnInfo, type Change, type Val } from "./api";
import { showConnectionManager } from "./connections";
import { icon, engineBadge, envColor, ENGINE_NAMES } from "./icons";
import { applyTheme, currentTheme, esc, toast } from "./ui";
import { showTablePlusImport } from "./tpimport";
import { Grid } from "./grid";

interface Conn { id: number; name: string; kind: string; env?: string | null; sub?: string; objects: ObjectRef[]; schema: SchemaTable[] }
interface Tab {
  id: number; title: string; kind: "query" | "table";
  conn: Conn | null; table?: string;
  root: HTMLElement; grid: Grid; panel?: HTMLElement; gridWrap?: HTMLElement; cols?: ColumnInfo[]; schemaName?: string | null; bar?: HTMLElement; builder?: HTMLElement; edWrap?: HTMLElement; running?: boolean; cancelled?: boolean; structure?: ReturnType<typeof createStructureView>; mode?: "data" | "structure"; filterBar?: ReturnType<typeof createFilterBar>; filterWhere?: string; filterBtn?: HTMLElement; editor?: EditorView; status: HTMLElement;
}

let conn: Conn | null = null;
const tabs: Tab[] = [];
let active: Tab | null = null;
let tabSeq = 0;
const sqlLang = new Compartment();
const sqlHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--tok-keyword)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "var(--tok-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--tok-number)" },
  { tag: [t.lineComment, t.blockComment], color: "var(--tok-comment)", fontStyle: "italic" },
  { tag: [t.typeName, t.standard(t.typeName)], color: "var(--tok-type)" },
  { tag: [t.function(t.variableName), t.standard(t.name)], color: "var(--tok-fn)" },
  { tag: [t.punctuation, t.operator], color: "var(--soft)" },
]);

function langFor(c: Conn | null) {
  const dialect = c?.kind === "sqlite" ? SQLite : c?.kind === "mssql" ? MSSQL : c && ["mysql", "mariadb"].includes(c.kind) ? MySQL : PostgreSQL;
  return sql({ dialect, upperCaseKeywords: true });
}

async function formatEditor(view: EditorView, c: Conn | null) {
  // Loaded on first use to keep startup memory small.
  const { format: formatSql } = await import("sql-formatter");
  const language = c?.kind === "sqlite" ? "sqlite" : c?.kind === "mssql" ? "transactsql" : c && ["mysql", "mariadb"].includes(c.kind) ? "mysql" : "postgresql";
  const sel = view.state.selection.main;
  const [from, to] = sel.empty ? [0, view.state.doc.length] : [sel.from, sel.to];
  try {
    const out = formatSql(view.state.sliceDoc(from, to), { language, keywordCase: "upper" });
    view.dispatch({ changes: { from, to, insert: out } });
  } catch { /* leave text untouched when the SQL cannot be parsed */ }
}

const app = document.getElementById("app")!;
applyTheme(currentTheme());
const iconBtn = (id: string, ic: string, title: string) => `<button id="${id}" class="btn btn-ghost" style="width:28px;padding:0;justify-content:center" title="${title}" aria-label="${title}">${icon(ic, 16)}</button>`;
app.innerHTML = `
  <div class="h-full flex">
    <aside class="w-[252px] shrink-0 bg-canvas border-r border-line flex flex-col">
      <div class="titlebar h-11 shrink-0"></div>
      <button id="switch" class="mx-2.5 mb-2.5 flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-raised" title="Switch connection (⌘O)">
        <span id="sw-badge"></span>
        <span class="min-w-0 flex-1"><span id="sw-name" class="block font-medium truncate">Not connected</span><span id="sw-sub" class="block text-[11px] text-muted truncate">Choose a connection</span></span>
        <span class="text-muted">${icon("chevronDown", 14)}</span>
      </button>
      <div class="px-2.5 mb-2 relative">
        <span class="absolute left-5 top-[7px] text-muted pointer-events-none">${icon("search", 14)}</span>
        <input id="filter" placeholder="Search tables" class="field w-full" style="padding-left:28px" />
        <span class="kbd absolute right-5 top-[5px] pointer-events-none">⌘P</span>
      </div>
      <div id="objects" class="flex-1 overflow-auto px-1.5 pb-2 text-[12.5px]"></div>
      <div class="border-t border-line px-2.5 py-2 flex items-center gap-1">
        <button id="open" class="btn btn-ghost flex-1" style="justify-content:flex-start">${icon("plug", 15)}<span>Connections</span><span class="kbd ml-auto">⌘O</span></button>
        <button id="theme" class="btn btn-ghost" style="width:28px;padding:0;justify-content:center" title="Switch theme"></button>
      </div>
    </aside>
    <div class="flex-1 min-w-0 flex flex-col">
      <div class="titlebar h-11 shrink-0 bg-canvas border-b border-line flex items-end px-2 gap-2">
        <div id="tabs" class="flex items-end overflow-x-auto flex-1 min-w-0 h-full"></div>
        <div class="flex items-center gap-0.5 pb-1.5">
          ${iconBtn("import", "upload", "Import a file… (⌘⌥I)")}${iconBtn("export", "download", "Export the result… (⌘⌥E)")}${iconBtn("newtab", "plus", "New query tab (⌘T)")}
        </div>
      </div>
      <main id="main" class="flex-1 min-h-0 flex flex-col bg-panel"></main>
    </div>
  </div>
  <div id="palette" class="hidden fixed inset-0 flex items-start justify-center pt-24 z-50" style="background:color-mix(in srgb, var(--ink) 28%, transparent)">
    <div class="w-[560px] bg-panel rounded-xl shadow-pop border border-line-strong overflow-hidden">
      <input id="pinput" placeholder="Open a table, view or collection" class="w-full bg-panel px-4 py-3 outline-none border-b border-line text-[14px]"/>
      <div id="plist" class="max-h-80 overflow-auto py-1"></div>
    </div>
  </div>`;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function makeTab(kind: Tab["kind"], title: string, table?: string): Tab {
  const root = document.createElement("div");
  root.className = "h-full flex flex-col min-h-0";
  const grid = new Grid();
  const status = document.createElement("div");
  status.className = "h-7 shrink-0 px-4 text-[11.5px] leading-7 text-soft bg-canvas border-t border-line truncate";
  const tab: Tab = { id: ++tabSeq, title, kind, conn, table, root, grid, status };
  if (kind === "query") {
    root.append(queryBar(tab));
    const ed = document.createElement("div");
    ed.className = "h-1/3 min-h-[80px] border-b border-line overflow-hidden";
    tab.editor = new EditorView({
      parent: ed,
      state: EditorState.create({
        doc: "",
        extensions: [
          lineNumbers(), history(), syntaxHighlighting(sqlHighlight), sqlLang.of(langFor(conn)),
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
    tab.edWrap = ed;
    root.append(ed);
  }
  const gridWrap = document.createElement("div");
  gridWrap.className = "flex-1 min-h-0";
  gridWrap.append(grid.el);
  tab.gridWrap = gridWrap;
  if (kind === "table") {
    const bar = document.createElement("div");
    bar.className = "h-10 shrink-0 flex items-center gap-1.5 px-3 bg-canvas border-b border-line text-[12px]";
    const btn = (label: string, title: string, f: () => void, ic?: string, cls = "btn") => {
      const b = document.createElement("button");
      b.innerHTML = (ic ? icon(ic, 14) : "") + `<span>${label}</span>`;
      b.title = title; b.className = cls; b.onclick = f;
      b.dataset.label = label;
      return b;
    };
    const commit = btn("Commit", "Review & commit changes (⌘S)", () => commitChanges(tab), "commit");
    const discard = btn("Discard", "Discard pending changes", () => grid.discard(), "undo");
    const info = document.createElement("span");
    info.className = "hint text-muted ml-2 truncate";
    const segWrap = document.createElement("div");
    segWrap.className = "inline-flex p-0.5 rounded-lg bg-raised mr-2";
    const seg = (label: string, mode: "data" | "structure", ic: string) => {
      const b = btn(label, mode === "data" ? "Table data" : "Table structure (columns, indexes, keys)", () => setMode(tab, mode), ic, "btn btn-ghost");
      b.style.height = "24px";
      b.dataset.mode = mode;
      return b;
    };
    segWrap.append(seg("Data", "data", "table"), seg("Structure", "structure", "structure"));
    const sep = document.createElement("span");
    sep.className = "hint w-px h-4 bg-line-strong mx-1";
    const sqlLike = !!conn && !["redis", "mongo"].includes(conn.kind);
    const filterBtn = btn("Filter", "Filter rows (⌘F)", () => tab.filterBar?.toggle(), "filter", "btn btn-ghost");
    filterBtn.dataset.label = "Filter";
    tab.filterBtn = filterBtn;
    if (sqlLike) {
      tab.filterBar = createFilterBar(
        () => (grid.columns.length ? grid.columns.map((c) => c.name) : (tab.cols ?? []).map((c) => c.name)),
        () => quoteFor(tab.conn),
        (where) => { tab.filterWhere = where || undefined; paintFilter(tab); reload(tab); },
      );
    }
    bar.append(segWrap, ...(sqlLike ? [filterBtn] : []), btn("Row", "Insert row (⌘I)", () => grid.addRow(), "plus", "btn btn-ghost"), btn("Row", "Delete selected row (⌘⌫)", () => grid.deleteSelected(), "minus", "btn btn-ghost"), sep, commit, discard, info);
    (bar.children[1] as HTMLElement).dataset.label = "+ Row"; (bar.children[2] as HTMLElement).dataset.label = "− Row";
    const refreshBar = () => {
      const n = grid.pendingCount;
      commit.toggleAttribute("disabled", n === 0);
      discard.toggleAttribute("disabled", n === 0);
      commit.className = n ? "btn btn-primary" : "btn";
      info.textContent = !tab.cols ? "" : grid.editable ? (n ? `${n} pending change${n > 1 ? "s" : ""}` : "Double-click a cell to edit") : "Read-only: this table has no primary key";
    };
    grid.onChange = refreshBar;
    refreshBar();
    setTimeout(() => setMode(tab, "data"), 0);
    tab.bar = bar;
    root.append(bar);
    if (tab.filterBar) root.append(tab.filterBar.el);
  }
  root.append(gridWrap, status);
  tabs.push(tab);
  activate(tab);
  tab.editor?.focus();
  return tab;
}

const quoteFor = (c: Conn | null) => (c?.kind === "mssql" ? (s: string) => "[" + s.replace(/]/g, "]]") + "]" : c && ["mysql", "mariadb"].includes(c.kind) ? (s: string) => "`" + s.replace(/`/g, "``") + "`" : (s: string) => '"' + s.replace(/"/g, '""') + '"');

/** ⌘B: toggle the visual query builder above the editor. */
function toggleBuilder() {
  const t = active;
  if (!t || t.kind !== "query" || !t.editor || !t.edWrap) return;
  if (t.builder) {
    t.builder.remove();
    t.builder = undefined;
    t.edWrap.className = "h-1/3 min-h-[80px] border-b border-line overflow-hidden";
    return;
  }
  t.builder = createBuilder(
    () => t.conn?.schema ?? [],
    () => quoteFor(t.conn),
    (text) => {
      if (!text) return;
      t.editor!.dispatch({ changes: { from: 0, to: t.editor!.state.doc.length, insert: text } });
    },
    () => t.conn?.kind === "mssql",
  );
  t.builder.className += " h-[45%] shrink-0";
  t.root.insertBefore(t.builder, t.edWrap);
  t.edWrap.className = "h-1/4 min-h-[70px] border-b border-line overflow-hidden";
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
    else { active = null; renderTabs(); showLauncher(); }
  } else renderTabs();
}

function renderTabs() {
  const el = $("tabs");
  el.replaceChildren(
    ...tabs.map((t, i) => {
      const on = t === active;
      const d = document.createElement("div");
      d.className = "group flex items-center gap-2 pl-3 pr-2 h-[34px] mb-[-1px] rounded-t-lg cursor-default text-[12.5px] max-w-52 shrink-0 border border-b-0 " +
        (on ? "bg-panel text-ink border-line" : "text-soft border-transparent hover:bg-raised");
      if (on) d.style.boxShadow = "inset 0 2px 0 var(--accent)";
      d.title = `${t.title}${i < 9 ? `  (⌘${i + 1})` : ""}`;
      d.innerHTML = `<span class="${on ? "text-accent" : "text-muted"}">${icon(t.kind === "table" ? "table" : "plan", 14)}</span><span class="truncate">${esc(t.title)}</span>`;
      const x = document.createElement("button");
      x.innerHTML = icon("close", 12);
      x.setAttribute("aria-label", "Close tab");
      x.className = "rounded p-0.5 text-muted hover:text-ink hover:bg-raised2 " + (on ? "" : "opacity-0 group-hover:opacity-100");
      x.onclick = (e) => { e.stopPropagation(); closeTab(t); };
      d.append(x);
      d.onclick = () => activate(t);
      d.onauxclick = () => closeTab(t);
      return d;
    }),
  );
  renderObjects();
}

async function exec(t: Tab, sqlText: string) {
  if (!t.conn) { t.status.textContent = "Not connected — open a database first (⌘O)"; return; }
  if (t.panel && t.gridWrap) { t.gridWrap.replaceChildren(t.grid.el); t.panel = undefined; }
  if (t.running) { t.status.textContent = "A query is already running — ⌘. to cancel"; return; }
  t.running = true; t.cancelled = false;
  t.status.textContent = "Running… (⌘. to cancel)";
  try {
    const s: Summary = await api.runQuery(t.conn.id, sqlText);
    await t.grid.setResult(s.columns.length ? s : null);
    t.status.textContent = s.columns.length
      ? `${s.row_count.toLocaleString()} rows${s.truncated ? " (truncated)" : ""} · ${s.elapsed_ms} ms`
      : `${s.affected ?? 0} rows affected · ${s.elapsed_ms} ms`;
    if (/^\s*(create|drop|alter)\b/i.test(sqlText)) refreshObjects();
  } catch (e) {
    await t.grid.setResult(null);
    t.status.textContent = t.cancelled ? "Query cancelled" : "Error: " + e;
    t.status.classList.toggle("text-danger", !t.cancelled);
    t.running = false;
    return;
  }
  t.running = false;
  t.status.classList.remove("text-danger");
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
    t.status.classList.add("text-danger");
  }
}

function confirmSql(stmts: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const o = document.createElement("div");
    o.className = "fixed inset-0 bg-black/50 flex items-center justify-center z-50";
    o.innerHTML = `<div class="w-[640px] max-h-[70vh] bg-raised rounded-lg border border-line-strong shadow-2xl flex flex-col">
      <div class="px-4 py-2 border-b border-line-strong font-semibold">Review changes (${stmts.length} statement${stmts.length > 1 ? "s" : ""}, one transaction)</div>
      <pre class="mono text-[12px] p-4 overflow-auto flex-1 select-text whitespace-pre-wrap"></pre>
      <div class="p-3 flex justify-end gap-2 border-t border-line-strong">
        <button id="no" class="px-3 py-1 rounded hover:bg-raised2">Cancel</button>
        <button id="yes" class="px-3 py-1 rounded btn-primary">Commit</button></div></div>`;
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

function setMode(t: Tab, mode: "data" | "structure") {
  if (t.kind !== "table" || !t.gridWrap || !t.conn || !t.table) return;
  t.mode = mode;
  t.bar?.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => {
    const on = b.dataset.mode === mode;
    b.style.background = on ? "var(--panel)" : "transparent";
    b.style.color = on ? "var(--ink)" : "var(--soft)";
    b.style.boxShadow = on ? "0 1px 2px rgb(20 28 46 / .12)" : "none";
  });
  const dataOnly = ["+ Row", "− Row", "Commit", "Discard", "Filter"];
  if (mode === "structure" && t.filterBar?.open) t.filterBar.toggle();
  t.bar?.querySelectorAll<HTMLElement>(".hint").forEach((h) => { h.style.display = mode === "data" ? "" : "none"; });
  t.bar?.querySelectorAll<HTMLElement>("button[data-label]").forEach((b) => { if (dataOnly.includes(b.dataset.label ?? "")) b.style.display = mode === "data" ? "" : "none"; });
  if (mode === "data") { t.gridWrap.replaceChildren(t.grid.el); return; }
  const conn = t.conn, name = t.table;
  const o = conn.objects.find((x) => x.name === name);
  t.schemaName = o?.schema ?? null;
  if (!t.structure) {
    t.structure = createStructureView(
      () => api.describe(conn.id, t.schemaName ?? null, name),
      async (changes) => {
        if (!changes.length) return false;
        const ddl = await api.applyStructure(conn.id, t.schemaName ?? null, name, changes, true);
        if (!(await confirmSql(ddl))) return false;
        await api.applyStructure(conn.id, t.schemaName ?? null, name, changes, false);
        t.cols = undefined; // force the data tab to re-read primary keys
        refreshSchema(conn);
        return true;
      },
      (m) => { t.status.textContent = m; },
    );
  }
  t.gridWrap.replaceChildren(t.structure.el);
  t.structure.reload().catch((e) => { t.status.textContent = "Cannot read structure: " + e; });
}

/** Re-read table/column names for completion and the sidebar after DDL. */
function refreshSchema(c: Conn) {
  api.listObjects(c.id).then((o) => { c.objects = o; if (conn === c) renderObjects(); });
  api.schemaMap(c.id).then((m) => { c.schema = m; }).catch(() => {});
}

/** Highlight the Filter button while a filter is active. */
function paintFilter(t: Tab) {
  if (!t.filterBtn) return;
  t.filterBtn.className = t.filterWhere ? "btn btn-primary" : "btn btn-ghost";
  t.filterBtn.querySelector("span")!.textContent = t.filterWhere ? "Filtered" : "Filter";
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
      .then(() => api.selectAllSql(t.conn!.id, t.schemaName ?? null, t.table!, undefined, t.filterWhere))
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

const collapsed = new Set<string>();
function renderObjects() {
  const host = $("objects");
  if (!conn) { host.innerHTML = `<div class="px-3 py-6 text-muted text-center">Connect to a database to see its tables.</div>`; return; }
  const q = $<HTMLInputElement>("filter").value.toLowerCase();
  const items = conn.objects.filter((o) => o.name.toLowerCase().includes(q));
  const groups: [string, string, string][] = [["table", "Tables", "table"], ["view", "Views", "view"], ["collection", "Collections", "collection"], ["key", "Keys", "key"]];
  const open = active?.kind === "table" && active.conn === conn ? active.table : undefined;
  const frag = document.createDocumentFragment();
  for (const [kind, label, ic] of groups) {
    const list = items.filter((o) => o.kind === kind);
    if (!list.length) continue;
    const head = document.createElement("div");
    const shut = collapsed.has(kind) && !q;
    head.className = "flex items-center gap-1 px-2 pt-2 pb-1 text-[11.5px] font-medium text-muted cursor-default select-none";
    head.innerHTML = `<span style="display:inline-block;transition:transform .12s;transform:rotate(${shut ? 0 : 90}deg)">${icon("chevron", 11)}</span><span>${label}</span><span class="ml-auto">${list.length}</span>`;
    head.onclick = () => { shut ? collapsed.delete(kind) : collapsed.add(kind); renderObjects(); };
    frag.append(head);
    if (shut) continue;
    for (const o of list.slice(0, 2000)) {
      const d = document.createElement("div");
      const on = o.name === open;
      d.className = "flex items-center gap-2 pl-5 pr-2 h-[26px] rounded-md cursor-default " + (on ? "bg-accent-soft text-ink font-medium" : "hover:bg-raised text-ink");
      d.innerHTML = `<span class="${on ? "text-accent" : "text-muted"}">${icon(ic, 14)}</span><span class="truncate">${esc((o.schema && o.schema !== "public" ? o.schema + "." : "") + o.name)}</span>`;
      d.title = "Double-click to open";
      d.ondblclick = () => openTable(o.name);
      frag.append(d);
    }
  }
  if (!frag.childNodes.length) host.innerHTML = `<div class="px-3 py-6 text-muted text-center">${q ? "No matches." : "This database has no tables yet."}</div>`;
  else host.replaceChildren(frag);
}

function paintSwitcher() {
  $("sw-badge").innerHTML = conn ? engineBadge(conn.kind, 30) : `<span class="inline-flex items-center justify-center rounded-lg bg-raised text-muted" style="width:30px;height:30px">${icon("database", 16)}</span>`;
  $("sw-name").textContent = conn?.name ?? "Not connected";
  $("sw-sub").textContent = conn ? (conn.sub || ENGINE_NAMES[conn.kind] || conn.kind) : "Choose a connection";
  $("sw-sub").style.color = conn?.env === "production" ? "var(--env-production)" : "";
  $("switch").style.boxShadow = conn ? `inset 3px 0 0 ${envColor(conn.env)}` : "none";
}

async function useConnection(id: number, p: { name: string; kind: string; environment?: string | null; host?: string | null; port?: number | null; database?: string | null; path?: string | null }) {
  const where = p.path ?? [p.host, p.port && `:${p.port}`].filter(Boolean).join("");
  const c: Conn = { id, name: p.name, kind: p.kind, env: p.environment, sub: [ENGINE_NAMES[p.kind] ?? p.kind, p.environment === "production" ? "production" : ""].filter(Boolean).join(" · ") || where, objects: [], schema: [] };
  conn = c;
  paintSwitcher();
  await refreshObjects();
  api.schemaMap(id).then((m) => {
    c.schema = m;
    // Re-point every open query editor of this connection at the new schema.
    for (const t of tabs) {
      if (!t.editor || t.conn !== c) continue;
      t.editor.dispatch({ effects: sqlLang.reconfigure(langFor(c)) });
      (t.builder as (HTMLElement & { refresh?: () => void }) | undefined)?.refresh?.();
    }
  }).catch(() => {});
  if (!tabs.length) makeTab("query", "Query"); else if (!active) activate(tabs[0]);
}

function queryBar(tab: Tab): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "h-10 shrink-0 flex items-center gap-1 px-3 bg-canvas border-b border-line text-[12px]";
  const b = (html: string, title: string, f: () => void, cls = "btn btn-ghost") => {
    const el = document.createElement("button");
    el.innerHTML = html; el.title = title; el.className = cls; el.onclick = f;
    return el;
  };
  const sep = () => { const x = document.createElement("span"); x.className = "w-px h-4 bg-line-strong mx-1.5"; return x; };
  const pill = document.createElement("span");
  pill.className = "pill ml-auto";
  pill.innerHTML = tab.conn ? `<span style="width:7px;height:7px;border-radius:4px;background:${envColor(tab.conn.env)}"></span>${esc(tab.conn.name)}` : "No connection";
  bar.append(
    b(`${icon("play", 13)}<span>Run</span><span class="kbd" style="color:inherit;border-color:rgb(255 255 255 / .4);background:transparent">⌘↵</span>`, "Run the selection, or the whole editor (⌘Enter)", () => { activate(tab); runActive(); }, "btn btn-primary"),
    b(`${icon("stop", 13)}<span>Stop</span>`, "Cancel the running query (⌘.)", () => { activate(tab); cancelActive(); }),
    sep(),
    b(`${icon("plan", 14)}<span>Explain</span>`, "Show the query plan and suggestions (⌘E)", () => { activate(tab); explainActive(false); }),
    b(`${icon("wand", 14)}<span>Format</span>`, "Format SQL (⌘I)", () => tab.editor && formatEditor(tab.editor, tab.conn)),
    b(`${icon("blocks", 14)}<span>Builder</span>`, "Visual query builder (⌘B)", () => { activate(tab); toggleBuilder(); }),
    pill,
  );
  return bar;
}

/** The home view: saved connections, plus a one-click way to bring them over from TablePlus. */
async function showLauncher() {
  active = null;
  renderTabs();
  const wrap = document.createElement("div");
  wrap.className = "h-full overflow-auto";
  $("main").replaceChildren(wrap);
  const [profiles, tp] = await Promise.all([api.listConnections().catch(() => [] as Profile[]), api.tableplusScan().catch(() => [])]);
  if (active || $("main").firstChild !== wrap) return; // user moved on while we were loading
  const importable = tp.filter((e) => e.kind && !e.already_imported);
  wrap.innerHTML = `<div class="mx-auto px-8 pt-14 pb-10" style="max-width:720px">
    <h1 class="text-[24px] font-semibold tracking-[-0.01em]">Connections</h1>
    <p class="text-soft mt-1">Open a database, or add a new one.</p>
    ${importable.length ? `<div id="tpbanner" class="mt-6 flex items-center gap-4 rounded-xl px-4 py-3 bg-accent-soft" style="box-shadow: inset 3px 0 0 var(--accent)">
        <div class="flex-1"><div class="font-medium">${importable.length} connection${importable.length === 1 ? "" : "s"} found in TablePlus</div>
        <div class="text-soft text-[12.5px]">Bring them over instead of typing hosts and users again.</div></div>
        <button id="tpgo" class="btn btn-primary">Import from TablePlus</button></div>` : ""}
    <div id="rows" class="mt-6 rounded-xl border border-line-strong overflow-hidden bg-panel"></div>
    <div class="mt-5 flex items-center gap-2">
      <button id="newconn" class="btn">${icon("plus", 14)}<span>New connection</span><span class="kbd">⌘N</span></button>
      ${tp.length && !importable.length ? `<button id="tpgo2" class="btn btn-ghost">Import from TablePlus</button>` : ""}
    </div></div>`;
  const rows = wrap.querySelector("#rows") as HTMLElement;
  if (!profiles.length) {
    rows.innerHTML = `<div class="px-6 py-10 text-center"><div class="inline-flex text-muted mb-2">${icon("database", 28)}</div>
      <div class="font-medium">No saved connections yet</div><div class="text-soft mt-0.5">Add a connection, or import the ones you already have.</div></div>`;
  }
  const sorted = [...profiles].sort((a, b) => a.name.localeCompare(b.name));
  for (const p of sorted) {
    const row = document.createElement("div");
    row.className = "group flex items-center gap-3 px-4 h-[58px] cursor-default hover:bg-canvas border-b border-line last:border-b-0";
    row.style.boxShadow = `inset 3px 0 0 ${envColor(p.environment)}`;
    const where = p.path ?? [p.user && `${p.user}@`, p.host, p.port && `:${p.port}`, p.database && `/${p.database}`].filter(Boolean).join("");
    row.innerHTML = `${engineBadge(p.kind, 32)}
      <div class="min-w-0 flex-1"><div class="font-medium truncate">${esc(p.name)}</div><div class="mono text-[11.5px] text-muted truncate">${esc(where)}${p.ssh_host ? " · via SSH" : ""}</div></div>
      <div class="relative shrink-0" style="width:104px;height:28px">
        ${p.environment && p.environment !== "local" ? `<span class="pill absolute right-0 top-[5px] group-hover:opacity-0" style="color:${envColor(p.environment)}">${esc(p.environment)}</span>` : ""}
        <button class="btn btn-primary absolute right-0 top-0 opacity-0 group-hover:opacity-100 focus:opacity-100">Connect</button>
      </div>`;
    const go = async () => {
      const btn = row.querySelector("button")!;
      btn.textContent = "Connecting…"; btn.setAttribute("disabled", "");
      try { await connectProfile(p); } catch (e) { toast(`Couldn't connect to ${p.name}: ${e}`, "error"); btn.textContent = "Connect"; btn.removeAttribute("disabled"); }
    };
    row.ondblclick = go;
    row.querySelector("button")!.addEventListener("click", go);
    rows.append(row);
  }
  const doImport = async () => { if (await showTablePlusImport(tp)) showLauncher(); };
  (wrap.querySelector("#tpgo") as HTMLElement | null)?.addEventListener("click", doImport);
  (wrap.querySelector("#tpgo2") as HTMLElement | null)?.addEventListener("click", doImport);
  (wrap.querySelector("#newconn") as HTMLElement).onclick = openConnections;
}

async function connectProfile(p: Profile) {
  const id = await api.connectSaved(p.id);
  await useConnection(id, p);
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
      d.className = "px-4 py-1.5 flex items-center gap-2 " + (i === idx ? "bg-accent text-white" : "");
      d.innerHTML = `${icon(o.kind === "view" ? "view" : o.kind === "key" ? "key" : o.kind === "collection" ? "collection" : "table", 14)}<span>${esc(o.name)}</span><span class="ml-auto text-[11px] opacity-70">${o.kind}</span>`;
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

/** ⌘⌥E: export the active tab's full result (not just the rows on screen) to a file. */
async function exportActive() {
  const t = active;
  if (!t?.conn) return;
  let sqlText: string;
  if (t.kind === "table" && t.table) {
    const o = t.conn.objects.find((x) => x.name === t.table);
    sqlText = await api.selectAllSql(t.conn.id, o?.schema ?? null, t.table, 2_000_000_000, t.filterWhere);
  } else if (t.kind === "query") sqlText = currentSql(t);
  else return;
  if (!sqlText.trim()) return;
  showExport(t.conn.id, sqlText, t.table ?? "export", (m) => { t.status.textContent = m; });
}

/** ⌘⌥I: import CSV / TSV / JSON into a table. */
async function importActive() {
  const c = active?.conn ?? conn;
  if (!c) return;
  const t = active;
  await showImport(c.id, c.objects, t?.kind === "table" ? t.table : undefined,
    async (o) => (await api.describe(c.id, o.schema, o.name)).columns.map((x) => x.name),
    async (msg) => {
      if (t) t.status.textContent = msg;
      await refreshObjects();
      // Reload an open table tab that was just imported into.
      for (const x of tabs) if (x.kind === "table" && x.conn === c && !x.grid.pendingCount) reload(x);
    });
}

async function cancelActive() {
  const t = active;
  if (!t?.running || !t.conn) return;
  t.cancelled = true;
  t.status.textContent = "Cancelling…";
  try { await api.cancelQuery(t.conn.id); } catch (e) { t.status.textContent = "Cancel failed: " + e; }
}

// Keyboard shortcuts (TablePlus-style)
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && active?.running) { e.preventDefault(); cancelActive(); return; }
  if (!e.metaKey) return;
  const k = e.key.toLowerCase();
  const go = (f: () => void) => { e.preventDefault(); f(); };
  // ⌥ changes e.key on macOS, so match the physical key for the ⌘⌥ combos.
  if (e.altKey && e.code === "KeyE") return go(exportActive);
  if (e.altKey && e.code === "KeyI") return go(importActive);
  if (k === "t") go(() => makeTab("query", "Query"));
  else if (k === "w") go(() => active && closeTab(active));
  else if (k === "o" || k === "n") go(openConnections);
  else if (k === "p") go(palette);
  else if (k === "r") go(() => active && reload(active));
  else if (k === "enter") go(runActive);
  else if (k === "e") go(() => explainActive(e.shiftKey));
  else if (k === "b") go(toggleBuilder);
  else if (e.key === ".") go(cancelActive);
  else if (k === "s" && active?.kind === "table") go(() => commitChanges(active!));
  else if (k === "i" && active?.kind === "table") go(() => active!.grid.addRow());
  else if (e.key === "Backspace" && active?.kind === "table" && !(e.target instanceof HTMLInputElement)) go(() => active!.grid.deleteSelected());
  else if (/^[1-9]$/.test(k)) go(() => tabs[+k - 1] && activate(tabs[+k - 1]));
  else if (e.shiftKey && (e.key === "]" || e.key === "}")) go(() => cycle(1));
  else if (e.shiftKey && (e.key === "[" || e.key === "{")) go(() => cycle(-1));
  else if (k === "f" && active?.kind === "table" && active.filterBar) go(() => { if (active!.mode === "structure") setMode(active!, "data"); active!.filterBar!.toggle(); });
  else if (k === "l" && e.shiftKey) go(toggleTheme);
  else if (k === "l") go(() => $("filter").focus());
});

function cycle(d: number) {
  if (!active) return;
  activate(tabs[(tabs.indexOf(active) + d + tabs.length) % tabs.length]);
}

$("import").onclick = importActive;
$("export").onclick = exportActive;
$("newtab").onclick = () => makeTab("query", "Query");
$("open").onclick = openConnections;
$("switch").onclick = () => { showLauncher(); };
const paintTheme = () => { $("theme").innerHTML = icon(currentTheme() === "dark" ? "sun" : "moon", 15); };
const toggleTheme = () => { applyTheme(currentTheme() === "dark" ? "light" : "dark"); paintTheme(); };
$("theme").onclick = toggleTheme;
paintTheme();
paintSwitcher();
renderObjects();
showLauncher();
$("filter").oninput = renderObjects;
